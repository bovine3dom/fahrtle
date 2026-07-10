// ==> src/store.ts <==
import { atom, map } from 'nanostores';
import { estimateServerMessageLatency, getMonotonicTime, syncClock } from './time-sync';
import { getTimeZone } from './timezone';
import { parseUserTime } from './utils/time';
import { throttle } from 'throttle-debounce';
import { sharedFakeServer } from './fakeServer';
import { type Difficulty, type GameBounds, CURRENT_LEAGUE, boundsToWire, wireToGameBounds } from './shared/gameLogic';
import { haversineDist } from './utils/geo';
import { formatRowTime } from './utils/format';
import { bindCurrentWebSocket } from './websocket';

export type { Difficulty };

if (typeof window !== 'undefined') {
  (window as any).getGameState = () => ({
    connected: $connected.get(),
    currentRoom: $currentRoom.get(),
    myPlayerId: $myPlayerId.get(),
    players: $players.get(),
    globalRate: $globalRate.get(),
    roomState: $roomState.get(),
    countdownEnd: $countdownEnd.get(),
    clock: $clock.get(),
    playerSpeeds: $playerSpeeds.get(),
    playerDistances: $playerDistances.get(),
    departureBoardResults: $departureBoardResults.get(),
    stopTimeZone: $stopTimeZone.get(),
    playerTimeZone: $playerTimeZone.get(),
    previewRoute: $previewRoute.get(),
    boardMinimized: $boardMinimized.get(),
    bounds: $gameBounds.get(),
  });
}

export type Waypoint = {
  x: number;
  y: number;
  startTime: number;
  arrivalTime: number;
  speedFactor: number;
  stopName?: string;
  isWalk?: boolean;
  route_color?: string;
  route_short_name?: string;
  display_name?: string;
  emoji?: string;
  route_departure_time?: string;
  timeStr?: string;
  isInterstop?: boolean;
  isWait?: boolean;
};

export type Player = {
  id: string;
  color: string;
  isReady: boolean;
  waypoints: Waypoint[];
  renderableSegments?: AnimationSegment[];
  finishTime?: number;
  disconnectedAt?: number | null;
  desiredRate?: number;
  forceRealtime?: boolean;
  viewingStopName?: string | null;
  isGhost: boolean;
};

export type AnimationSegment = {
  start: [number, number];
  end: [number, number];
  startTime: number;
  endTime: number;
  isInterstop: boolean;
};

type RenderablePlayer = Player & { isGhost: boolean } & { segments: AnimationSegment[] };

export interface DepartureResult {
  source: string;
  trip_id: string;
  stop_uuid: number;
  stop_lat: number;
  arrival_time: string | null;
  stop_lon: number;
  departure_time: string | null;
  next_stop: number;
  next_arrival: string | null;
  next_lat: number;
  next_lon: number;
  final_arrival: string | null;
  final_lat: number;
  final_lon: number;
  final_name: string;
  initial_lat: number;
  initial_lon: number;
  initial_name: string;
  initial_arrival: string | null;
  travel_time: number | null;
  route_type: number;
  stop_name: string;
  route_short_name: string;
  route_long_name: string;
  trip_headsign: string;
  sane_route_id: string;
  route_color: string;
  route_text_color: string;
  h3: number; // truncated UInt64 (!)
  bearing: number; // Added client-side
  bearing_origin: number; // Added client-side
  speed: number; // Added client-side
  dist: number; // Added client-side
}

export const $isSinglePlayer = atom(typeof localStorage !== 'undefined' ? localStorage.getItem('fahrtle_singleplayer') === 'true' : false);
export const $isDaily = atom(typeof localStorage !== 'undefined' ? localStorage.getItem('fahrtle_daily') === 'true' : false);
export const $currentDailyRaceIndex = atom<number | null>(null);
let ghostsFetchedForIndex: number | null = null;

const $connected = atom(false);
export const $currentRoom = atom<string | null>(null);
export const $myPlayerId = atom<string | null>(null);
export const $players = map<Record<string, RenderablePlayer>>({});
export const $globalRate = atom(1.0);
interface DepartureBoardResults {
  departures: DepartureResult[];
  arrivals: DepartureResult[];
}
export const $departureBoardResults = map<DepartureBoardResults>({ departures: [], arrivals: [] });
export const $departureBoardPage = atom(0);
export const $departureBoardLoadingMore = atom(false);
export const $departureBoardHasMore = atom(true);
export const $boardMode = atom<'departures' | 'arrivals'>('departures');
export const $lastClickContext = atom<{ h3Conditions: string, targetMinutes: number, stopTimeZone: string, clickTime: number } | null>(null);
export const $stopTimeZone = atom<string>('Europe/Paris');
export const $playerTimeZone = atom<string>('Europe/Paris');
export const $roomState = atom<'JOINING' | 'COUNTDOWN' | 'RUNNING'>('JOINING');
export const $countdownEnd = atom<number | null>(null);
export const $clock = atom(0);
interface PreviewRoute {
  coords: [number, number][];
  stopNames: string[];
  stopTimes: string[];
  row: DepartureResult;
}

export const $previewRoute = atom<PreviewRoute | null>(null);
export const $boardMinimized = atom(false);
export const $isFollowing = atom(false);
export const $playerSpeeds = map<Record<string, number>>({});
export const $playerDistances = map<Record<string, number | null>>({});
export const $gameBounds = atom<GameBounds>({ start: null, finish: null, time: undefined, difficulty: 'Normal', computerDriver: false, ghosts: false, league: CURRENT_LEAGUE });
export const $pickerMode = atom<'start' | 'finish' | null>(null);
export const $pickedPoint = atom<{ lat: number, lng: number, target: 'start' | 'finish' } | null>(null);
export const $gameStartTime = atom<number | null>(null);
export const $mapZoom = atom(14);
export const $isRerun = atom(false);
type Ping = { lat: number, lon: number, timestamp: number };
export const $pings = map<Record<string, Ping>>({});

import { loadStats, saveStats, type PlayerStats } from './utils/stats';
let $playerStatsInstance: PlayerStats;

if (typeof window !== 'undefined') {
  $playerStatsInstance = loadStats();
} else {
  $playerStatsInstance = {
    lastPlayedDate: '',
    daysPlayed: 0,
    racesStarted: 0,
    racesFinished: 0,
    countriesVisited: [],
    byCountry: {},
  };
}

export const $playerStats = atom<PlayerStats>($playerStatsInstance);

export function updatePlayerStats(updater: (stats: PlayerStats) => PlayerStats): void {
  const current = $playerStats.get();
  const updated = updater(current);
  $playerStats.set(updated);
  saveStats(updated);
}

import { defaultPlayerSettings } from './utils/playerSettings';
type SettingsType = typeof defaultPlayerSettings;
type SettingsValue = { [K in keyof SettingsType]: any };

const loadSettings = (): SettingsValue => {
  if (typeof localStorage === 'undefined') return Object.fromEntries(Object.keys(defaultPlayerSettings).map(k => [k, defaultPlayerSettings[k as keyof SettingsType].value])) as SettingsValue;

  const saved = localStorage.getItem('fahrtle_settings');
  let loaded: any = {};
  if (saved) {
    try {
      loaded = JSON.parse(saved);
    } catch (e) { console.error("Failed to parse settings", e) }
  }

  // Backwards compatibility for name and color
  if (!loaded.name && localStorage.getItem('fahrtle_user')) {
    loaded.name = localStorage.getItem('fahrtle_user');
  }
  if (!loaded.color && localStorage.getItem('fahrtle_color')) {
    loaded.color = localStorage.getItem('fahrtle_color');
  }

  const finalSettings: any = {};
  for (const key of Object.keys(defaultPlayerSettings)) {
    const k = key as keyof SettingsType;
    if (loaded[k] !== undefined) {
      finalSettings[k] = loaded[k];
    } else {
      finalSettings[k] = defaultPlayerSettings[k].value;
    }
  }
  return finalSettings as SettingsValue;
}

export const $playerSettings = atom<SettingsValue>(loadSettings());

export function updateSetting<K extends keyof SettingsValue>(key: K, value: SettingsValue[K]) {
  const current = $playerSettings.get();
  const next = { ...current, [key]: value };
  $playerSettings.set(next);

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('fahrtle_settings', JSON.stringify(next));

    // Sync legacy keys for backward compat
    if (key === 'name') localStorage.setItem('fahrtle_user', value as string);
    if (key === 'color') {
      localStorage.setItem('fahrtle_color', value as string);
      setPlayerColor(value as string);
    }
  }
}

interface GenericWebSocket {
  onopen: ((this: any, ev: any) => any) | null;
  onmessage: ((this: any, ev: any) => any) | null;
  onclose: ((this: any, ev: any) => any) | null;
  readyState: number;
  send(msg: string): void;
  close(): void;
}

let ws: GenericWebSocket | null = null;

function handleRoomState(msg: any) {
  const renderables: Record<string, RenderablePlayer> = {};
  for (const pid in msg.players) {
    renderables[pid] = processPlayer(msg.players[pid]);
    if (pid === $myPlayerId.get()) {
      const p = msg.players[pid];
      if (p.waypoints.length > 0) {
        const spawn = p.waypoints[0];
        $playerTimeZone.set(getTimeZone(spawn.y, spawn.x));
        if (p.waypoints.some((wp: any) => wp.arrivalTime > msg.serverTime) && msg.state === 'RUNNING') {
          $isFollowing.set(true);
        }
      }
    }
  }
  $players.set(renderables);
  $roomState.set(msg.state);
  $countdownEnd.set(msg.countdownEnd);
  const previousGhosts = $gameBounds.get().ghosts;
  $gameBounds.set(wireToGameBounds(msg));
  $gameStartTime.set(msg.gameStartTime);
  syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, estimateServerMessageLatency(msg.realTime));
  $globalRate.set(msg.rate);
  handleGhostFlags(previousGhosts, msg.ghosts);
}

function handleRoomStateUpdate(msg: any) {
  $roomState.set(msg.state);
  $countdownEnd.set(msg.countdownEnd);
  const prevGhosts = $gameBounds.get().ghosts;
  $gameBounds.set(wireToGameBounds(msg));
  $gameStartTime.set(msg.gameStartTime);
  $isRerun.set(msg.isRerun);
  syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, estimateServerMessageLatency(msg.realTime));
  $globalRate.set(msg.rate);
  handleGhostFlags(prevGhosts, msg.ghosts);
}

function handleGhostFlags(previousGhosts: boolean | undefined, currentGhosts: any) {
  if (previousGhosts && !currentGhosts) {
    removeGhosts();
  } else if (currentGhosts && $isDaily.get()) {
    const idx = $currentDailyRaceIndex.get();
    if (idx !== null) fetchAndAddGhosts(idx);
  }
}

function updatePlayerField(playerId: string, updates: (p: RenderablePlayer) => Partial<RenderablePlayer>) {
  const p = $players.get()[playerId];
  if (p) $players.setKey(playerId, { ...p, ...updates(p) });
}

function handleWsMessage(event: any) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'SYNC_RESPONSE') {
    const now = getMonotonicTime();
    syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, (now - msg.clientSendTime) / 2);
    $globalRate.set(msg.rate);
    return;
  }

  if (msg.type === 'CLOCK_UPDATE') {
    syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, estimateServerMessageLatency(msg.realTime));
    $globalRate.set(msg.rate);
    return;
  }

  if (msg.type === 'ROOM_STATE') { handleRoomState(msg); return; }
  if (msg.type === 'ROOM_STATE_UPDATE') { handleRoomStateUpdate(msg); return; }

  if (msg.type === 'READY_UPDATE') { updatePlayerField(msg.playerId, () => ({ isReady: msg.isReady })); return; }
  if (msg.type === 'PLAYER_JOINED') { $players.setKey(msg.player.id, processPlayer(msg.player)); return; }

  if (msg.type === 'PLAYER_LEFT') {
    const current = { ...$players.get() };
    delete current[msg.playerId];
    $players.set(current);
    return;
  }

  if (msg.type === 'WAYPOINT_ADDED') {
    const p = $players.get()[msg.playerId];
    if (p) $players.setKey(msg.playerId, processPlayer({ ...p, waypoints: [...p.waypoints, msg.waypoint], viewingStopName: null }));
    return;
  }

  if (msg.type === 'PLAYER_COLOR_UPDATE') { updatePlayerField(msg.playerId, () => ({ color: msg.color })); return; }
  if (msg.type === 'PLAYER_SNOOZE_UPDATE') { updatePlayerField(msg.playerId, () => ({ desiredRate: msg.desiredRate, forceRealtime: msg.forceRealtime })); return; }
  if (msg.type === 'PLAYER_DISCONNECT_UPDATE') { updatePlayerField(msg.playerId, () => ({ disconnectedAt: msg.disconnectedAt })); return; }
  if (msg.type === 'PLAYER_VIEW_UPDATE') { updatePlayerField(msg.playerId, () => ({ viewingStopName: msg.viewingStopName })); return; }
  if (msg.type === 'PLAYER_FINISH_UPDATE') { updatePlayerField(msg.playerId, () => ({ finishTime: msg.finishTime })); return; }

  if (msg.type === 'PLAYER_WAYPOINTS_UPDATE') {
    const p = $players.get()[msg.playerId];
    if (p) $players.setKey(msg.playerId, processPlayer({ ...p, waypoints: msg.waypoints, viewingStopName: null }));
    return;
  }

  if (msg.type === 'RECV_PING') {
    $pings.setKey(msg.playerId, { lat: msg.lat, lon: msg.lon, timestamp: msg.timestamp });
  }
}

function sendInitialBounds(initialBounds: GameBounds & { time?: string, dailyRaceIndex?: number }, socket = ws) {
  let startTime: number | undefined;
  const startPos = initialBounds.start || [51, 0];
  if (startPos && initialBounds.time) {
    const tz = getTimeZone(startPos[0], startPos[1]);
    const parsed = parseUserTime(initialBounds.time, tz);
    if (parsed !== null) startTime = parsed;
  }

  socket?.send(JSON.stringify({
    type: 'SET_GAME_BOUNDS',
    ...boundsToWire({
      start: initialBounds.start,
      finish: initialBounds.finish,
      time: startTime,
      difficulty: initialBounds.difficulty || 'Normal',
      computerDriver: initialBounds.computerDriver || false,
      ghosts: initialBounds.ghosts || false,
      league: initialBounds.league,
    }),
  }));

  if (initialBounds.dailyRaceIndex !== undefined) {
    if (initialBounds.ghosts) fetchAndAddGhosts(initialBounds.dailyRaceIndex);
    else removeGhosts();
  }

  $gameBounds.set({
    start: initialBounds.start,
    finish: initialBounds.finish,
    time: startTime,
    difficulty: initialBounds.difficulty || 'Normal',
    computerDriver: initialBounds.computerDriver || false,
    ghosts: initialBounds.ghosts || false,
    league: initialBounds.league,
  });

  if (initialBounds.dailyRaceIndex !== undefined) {
    $currentDailyRaceIndex.set(initialBounds.dailyRaceIndex);
  }
}

export function connectAndJoin(roomId: string | null, playerId: string, color?: string, initialBounds?: GameBounds & { time?: string, dailyRaceIndex?: number }) {
  if (ws) ws.close();

  if ($isSinglePlayer.get()) {
    ws = sharedFakeServer.connect(roomId || ($isDaily.get() ? 'daily' : 'solo'), playerId) as any;
  } else {
    const wsUri = import.meta.env.PROD
      ? import.meta.env.VITE_FAHRTLE_WS_URI
      : 'ws://localhost:8080';
    ws = new WebSocket(wsUri || '') as any;
  }

  if (!ws) return;
  const socket = ws;

  const effectiveRoomId = roomId || ($isDaily.get() ? 'daily' : 'solo');

  bindCurrentWebSocket(socket, (candidate) => ws === candidate, {
    open: () => {
      $connected.set(true);
      $currentRoom.set(effectiveRoomId);
      $myPlayerId.set(playerId);
      socket.send(JSON.stringify({ type: 'SYNC_REQUEST', clientSendTime: getMonotonicTime(), roomId: effectiveRoomId }));
      socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: effectiveRoomId, playerId, color }));
      if (initialBounds) sendInitialBounds(initialBounds, socket);
    },
    message: handleWsMessage,
    close: () => {
      ws = null;
      $connected.set(false);
      $currentRoom.set(null);
      ghostsFetchedForIndex = null;
    },
  });
}

async function removeGhosts() {
  const allPlayers = $players.get();
  const ghostPlayers = Object.values(allPlayers).filter(p => p.isGhost);

  if (ghostPlayers.length === 0) return;

  if (ws && ws.readyState === 1) {
    for (const ghost of ghostPlayers) {
      ws.send(JSON.stringify({
        type: 'PLAYER_KICK',
        playerId: ghost.id
      }));
    }
  }

  const current = { ...allPlayers };
  for (const ghost of ghostPlayers) {
    delete current[ghost.id];
  }
  $players.set(current);

  ghostsFetchedForIndex = null;
}

async function fetchAndAddGhosts(dailyRaceIndex: number) {
  if (ghostsFetchedForIndex === dailyRaceIndex) return;
  
  ghostsFetchedForIndex = dailyRaceIndex;
  
  if (!ws || ws.readyState !== 1) return;
  const socket = ws;
  
  const apiUrl = import.meta.env.PROD ? '' : 'http://localhost:8080/';
  
  const url = `${apiUrl}api/ghosts/${dailyRaceIndex}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const ghosts = await response.json();
    
    if (ghosts && ghosts.length > 0 && ws === socket && socket.readyState === 1 && ghostsFetchedForIndex === dailyRaceIndex) {
      socket.send(JSON.stringify({
        type: 'ADD_GHOSTS',
        ghosts: ghosts.map((g: any) => ({
          playerId: g.playerId,
          playerName: g.playerName,
          color: g.color ?? `hsl(${Math.floor(Math.random() * 360)}, 30%, 50%)`,
          waypoints: g.waypoints,
          finishTime: g.finishTime
        }))
      }));
    }
  } catch (e) {
    console.error('Failed to fetch ghosts:', e);
  }
}

export async function submitGhostWaypoints(dailyRaceIndex: number, finishTime: number) {
  const myId = $myPlayerId.get();
  const allPlayers = $players.get();
  const player = myId ? allPlayers[myId] : null;
  
  if (!player || !myId) return;
  
  const playerName = $playerSettings.get().name || myId;
  
  const nonInterstopWaypoints = player.waypoints.filter(wp => !wp.isInterstop);
  
  if (nonInterstopWaypoints.length === 0) return;

  const apiUrl = import.meta.env.PROD ? '' : 'http://localhost:8080/';

  try {
    await fetch(`${apiUrl}api/ghosts/${dailyRaceIndex}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: myId,
        playerName: playerName,
        color: player.color,
        waypoints: nonInterstopWaypoints,
        finishTime: finishTime
      })
    });
  } catch (e) {
    console.error('Failed to submit ghost waypoints:', e);
  }
}

export function submitWaypoint(lat: number, lng: number) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const myId = $myPlayerId.get();
  const allPlayers = $players.get();
  const player = myId ? allPlayers[myId] : null;

  if (!player) return;

  ws.send(JSON.stringify({
    type: 'ADD_WAYPOINT',
    x: lng,
    y: lat,
    speedFactor: 20,
    stopName: 'walking',
    isWalk: true
  }));
}

function buildWaypoint(p: any, arrivalTime: number, speedFactor: number, overrides: Partial<any> = {}) {
  return {
    x: p.lng, y: p.lat, arrivalTime, speedFactor,
    stopName: p.stopName, isInterstop: p.isInterstop,
    route_color: p.route_color, route_short_name: p.route_short_name,
    display_name: p.display_name, emoji: p.emoji,
    route_departure_time: p.route_departure_time, timeStr: p.timeStr,
    ...overrides,
  };
}

export function submitWaypointsBatch(points: {
  lng: number,
  lat: number,
  time: number,
  stopName?: string,
  route_color?: string,
  route_short_name?: string,
  display_name?: string,
  emoji?: string,
  route_departure_time?: string | null,
  timeStr?: string,
  isInterstop?: boolean,
}[], opts: { isTeleport?: boolean } = {}) {
  if (points.length === 0 || !ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const myId = $myPlayerId.get();
  const player = myId ? $players.get()[myId] : null;
  if (!player) return;

  const clockTime = $clock.get();
  const isTeleport = opts.isTeleport ?? false;

  const BASE_SPEED = 5 / (60 * 60 * 1000);

  const lastWaypoint = player.waypoints.length > 0 ? player.waypoints[player.waypoints.length - 1] : null;
  const startX = lastWaypoint?.x ?? points[0].lng;
  const startY = lastWaypoint?.y ?? points[0].lat;
  const distance = haversineDist({ lat: startY, lon: startX }, { lat: points[0].lat, lon: points[0].lng }) || 0;
  const walkingDuration = distance / BASE_SPEED;
  const walkingArrival = clockTime + walkingDuration;
  const departureTime = points[0].time;
  const waitArrival = departureTime - (1000 * 60);

  let totalVirtualTime = 0;
  let lastRealTime = clockTime;
  for (const p of points) {
    if (!p.isInterstop) {
      totalVirtualTime += Math.max(1000, p.time - lastRealTime);
      lastRealTime = p.time;
    }
  }
  if (lastRealTime < points[points.length - 1].time) {
    totalVirtualTime += (points[points.length - 1].time - lastRealTime);
  }

  const batchSpeedFactor = Math.max(1.0, totalVirtualTime / 30000);

  const waypointSpeeds = new Array(points.length);
  let segmentStartIdx = 0;
  let segmentStartTime = clockTime;

  while (segmentStartIdx < points.length) {
    let nextRealIdx = segmentStartIdx;
    while (nextRealIdx < points.length - 1 && points[nextRealIdx].isInterstop) {
      nextRealIdx++;
    }

    const p = points[nextRealIdx];
    const legVirtualTime = p.isInterstop ? (p.time - segmentStartTime) : Math.max(1000, p.time - segmentStartTime);
    const legSpeedLimit = legVirtualTime / 2000;
    const legSpeedFactor = Math.max(1.0, Math.min(batchSpeedFactor, legSpeedLimit));

    for (let k = segmentStartIdx; k <= nextRealIdx; k++) {
      waypointSpeeds[k] = legSpeedFactor;
    }

    segmentStartTime = p.time;
    segmentStartIdx = nextRealIdx + 1;
  }

  const waypointsToSubmit: any[] = [];

  if (isTeleport) {
    for (let i = 0; i < points.length; i++) {
      waypointsToSubmit.push(buildWaypoint(points[i], clockTime, 1));
    }
  } else {
    waypointsToSubmit.push(buildWaypoint(points[0], walkingArrival, waypointSpeeds[0], { isWalk: true, isInterstop: false, emoji: '🐾' }));

    if (waitArrival > walkingArrival) {
      waypointsToSubmit.push(buildWaypoint(points[0], waitArrival, waypointSpeeds[0], {
        isWait: true, isInterstop: false, emoji: '⏳',
        stopName: `waiting for ${formatRowTime(points[0].route_departure_time || '')} ${points[0].route_short_name || ''}`.trim(),
      }));
    }

    for (let i = 1; i < points.length; i++) {
      waypointsToSubmit.push(buildWaypoint(points[i], points[i].time - (points[i].isInterstop ? 0 : (1000 * 60)), waypointSpeeds[i]));
    }
  }

  ws.send(JSON.stringify({
    type: 'ADD_WAYPOINTS_BATCH',
    waypoints: waypointsToSubmit
  }));
}

export function leaveRoom() {
  // clear the room id from the URL search params
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState(null, '', url); // bug: it flashes back up again instantly, but we don't rejoin, so that's nice
  if (ws) ws.close();
  $currentRoom.set(null);
  $isDaily.set(false);
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('fahrtle_daily');
    localStorage.removeItem('fahrtle_room');
  }
  $players.set({});
  window.location.reload(); // clearing up state is too hard. make the browser do it
}

const throttledSetColor = throttle(200, (color: string) => {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'UPDATE_PLAYER_COLOR', color }));
});

function setPlayerColor(color: string) {
  localStorage.setItem('fahrtle_color', color);
  throttledSetColor(color);
}

export function toggleReady() {
  ws?.send(JSON.stringify({ type: 'TOGGLE_READY' }));
}

export function raceAgain(waypoints: Waypoint[]) {
  ws?.send(JSON.stringify({ type: 'RACE_AGAIN', waypoints }));
}

export function toggleSnooze() {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'TOGGLE_SNOOZE' }));
}

export function forceRealtime() {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'FORCE_REALTIME' }));
}

export function stopImmediately(destinationWpIndex?: number) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'STOP_IMMEDIATELY', destinationWpIndex }));
}

export function sendPing(lat: number, lon: number) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'SEND_PING', lat, lon }));
}

function processPlayer(raw: Player): RenderablePlayer {
  const segments: AnimationSegment[] = [];
  const myStart = $players.get()[$myPlayerId.get()||'']?.waypoints[0].startTime;
  const offset = myStart - raw?.waypoints[0].startTime; // this hack doesn't feel right

  for (let i = 0; i < raw.waypoints.length; i++) {
    const wp = raw.waypoints[i];
    if (i > 0) {
      const prev = raw.waypoints[i - 1];
      segments.push({
        start: [prev.x, prev.y],
        end: [wp.x, wp.y],
        startTime: wp.startTime + offset,
        endTime: wp.arrivalTime + offset,
        isInterstop: wp.isInterstop || false
      });
    }
  }

  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startTime !== segments[i - 1].endTime) {
      segments[i].startTime = segments[i - 1].endTime;
    }
  }

  return {
    ...raw,
    isGhost: raw.isGhost,
    segments
  };
}

export function setGameBounds(partial: Partial<GameBounds>) {
  const current = $gameBounds.get();
  const merged: GameBounds = {
    ...current,
    ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)),
  } as GameBounds;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'SET_GAME_BOUNDS',
      ...boundsToWire(merged),
    }));

    if (current.ghosts && !merged.ghosts) {
      removeGhosts();
    }
  }
}

export function finishRace(finishTime: number) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({
    type: 'PLAYER_FINISHED',
    finishTime: finishTime
  }));
}

export function setViewingStop(stopName: string | null) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({ type: 'SET_VIEWING_STOP', stopName }));
}
