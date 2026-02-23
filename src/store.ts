// ==> src/store.ts <==
import { atom, map } from 'nanostores';
import { syncClock } from './time-sync';
import { getTimeZone } from './timezone';
import { parseUserTime } from './utils/time';
import { throttle } from 'throttle-debounce';
import { sharedFakeServer } from './fakeServer';
import { type Difficulty } from './shared/gameLogic';
import { haversineDist } from './utils/geo';
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
export const $gameBounds = atom<{ start: [number, number] | null, finish: [number, number] | null, time?: number, difficulty: Difficulty, computerDriver?: boolean }>({ start: null, finish: null, time: undefined, difficulty: 'Normal', computerDriver: false });
export const $pickerMode = atom<'start' | 'finish' | null>(null);
export const $pickedPoint = atom<{ lat: number, lng: number, target: 'start' | 'finish' } | null>(null);
export const $gameStartTime = atom<number | null>(null);
export const $mapZoom = atom(14);
export const $isRerun = atom(false);

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

export function connectAndJoin(roomId: string | null, playerId: string, color?: string, initialBounds?: { start: [number, number] | null, finish: [number, number] | null, time?: string, difficulty?: Difficulty, computerDriver?: boolean }) {
  if (ws) ws.close();

  if ($isSinglePlayer.get()) {
    ws = sharedFakeServer.connect(roomId || ($isDaily.get() ? 'daily' : 'solo'), playerId) as any;
  } else {
    const wsUri = import.meta.env.PROD
      ? import.meta.env.VITE_FAHRTLE_WS_URI
      : 'ws://localhost:8080';
    ws = new WebSocket(wsUri) as any;
  }

  if (!ws) return;

  ws.onopen = () => {
    $connected.set(true);

    ws?.send(JSON.stringify({
      type: 'SYNC_REQUEST',
      clientSendTime: Date.now(),
      roomId: roomId || ($isDaily.get() ? 'daily' : 'solo')
    }));

    ws?.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: roomId || ($isDaily.get() ? 'daily' : 'solo'), playerId, color }));

    if (initialBounds) {
      let startTime: number | undefined;

      const startPos = initialBounds.start || [51, 0] // gmt
      if (startPos && initialBounds.time) {
        const tz = getTimeZone(startPos[0], startPos[1]);
        const parsed = parseUserTime(initialBounds.time, tz);
        if (parsed !== null) startTime = parsed;
      }

      ws?.send(JSON.stringify({
        type: 'SET_GAME_BOUNDS',
        startPos: initialBounds.start,
        finishPos: initialBounds.finish,
        startTime: startTime,
        difficulty: initialBounds.difficulty || 'Normal',
        computerDriver: initialBounds.computerDriver || false
      }));

      $gameBounds.set({
        start: initialBounds.start,
        finish: initialBounds.finish,
        time: startTime,
        difficulty: initialBounds.difficulty || 'Normal',
        computerDriver: initialBounds.computerDriver || false
      });
    }

    $currentRoom.set(roomId || ($isDaily.get() ? 'daily' : 'solo'));
    $myPlayerId.set(playerId);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'SYNC_RESPONSE') {
      const now = Date.now();
      const latency = (now - msg.clientSendTime) / 2;
      syncClock(msg.serverTime, msg.realTime || now, msg.rate, latency);
      $globalRate.set(msg.rate);
    }

    if (msg.type === 'CLOCK_UPDATE') {
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50);
      $globalRate.set(msg.rate);
    }

    if (msg.type === 'ROOM_STATE') {
      const renderables: Record<string, RenderablePlayer> = {};
      for (const pid in msg.players) {
        renderables[pid] = processPlayer(msg.players[pid]);

        if (pid === $myPlayerId.get()) {
          const p = msg.players[pid];
          if (p.waypoints.length > 0) {
            const spawn = p.waypoints[0];
            $playerTimeZone.set(getTimeZone(spawn.y, spawn.x));

            const isMoving = p.waypoints.some((wp: any) => wp.arrivalTime > msg.serverTime);
            if (isMoving && msg.state === 'RUNNING') {
              $isFollowing.set(true);
            }
          }
        }
      }
      $players.set(renderables);
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
      $gameBounds.set({ start: msg.startPos, finish: msg.finishPos, time: msg.serverTime, difficulty: msg.difficulty || 'Normal', computerDriver: msg.computerDriver });
      $gameStartTime.set(msg.gameStartTime);
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50);
    }

    if (msg.type === 'ROOM_STATE_UPDATE') {
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
      $gameBounds.set({ start: msg.startPos, finish: msg.finishPos, time: msg.serverTime, difficulty: msg.difficulty || 'Normal', computerDriver: msg.computerDriver });
      $gameStartTime.set(msg.gameStartTime);
      $isRerun.set(msg.isRerun);
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50);
    }

    if (msg.type === 'READY_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) {
        $players.setKey(msg.playerId, { ...p, isReady: msg.isReady });
      }
    }

    if (msg.type === 'PLAYER_JOINED') {
      $players.setKey(msg.player.id, processPlayer(msg.player));
    }

    if (msg.type === 'PLAYER_LEFT') {
      const current = { ...$players.get() };
      delete current[msg.playerId];
      $players.set(current);
    }

    if (msg.type === 'WAYPOINT_ADDED') {
      const all = $players.get();
      const p = all[msg.playerId];
      if (p) {
        const updatedWaypoints = [...p.waypoints, msg.waypoint];
        const updatedPlayer = processPlayer({ ...p, waypoints: updatedWaypoints, viewingStopName: null });
        $players.setKey(msg.playerId, updatedPlayer);
      }
    }

    if (msg.type === 'PLAYER_COLOR_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) $players.setKey(msg.playerId, { ...p, color: msg.color });
    }

    if (msg.type === 'PLAYER_SNOOZE_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) $players.setKey(msg.playerId, { ...p, desiredRate: msg.desiredRate, forceRealtime: msg.forceRealtime });
    }

    if (msg.type === 'PLAYER_VIEW_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) $players.setKey(msg.playerId, { ...p, viewingStopName: msg.viewingStopName });
    }

    if (msg.type === 'PLAYER_FINISH_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) $players.setKey(msg.playerId, { ...p, finishTime: msg.finishTime });
    }

    if (msg.type === 'PLAYER_WAYPOINTS_UPDATE') {
      const p = $players.get()[msg.playerId];
      if (p) {
        const updatedPlayer = processPlayer({ ...p, waypoints: msg.waypoints, viewingStopName: null });
        $players.setKey(msg.playerId, updatedPlayer);
      }
    }
  };

  ws.onclose = () => {
    $connected.set(false);
    $currentRoom.set(null);
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
}[],
  options: { isTeleport?: boolean } = {}
) {
  const { isTeleport = false } = options;
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const player = $players.get()[$myPlayerId.get() ?? ''];
  if (!player || points.length === 0) return;

  const clockTime = $clock.get();
  console.log('[submitWaypointsBatch] Submitting waypoints', {
    playerId: $myPlayerId.get(),
    clockTime,
    playerVirtualTime: player.waypoints[player.waypoints.length - 1]?.startTime,
    playerFinishTime: player.finishTime,
    pointCount: points.length,
    firstPointTime: points[0].time
  });

  const BASE_SPEED = 5 / (60 * 60 * 1000); // 5 km/h in km/ms

  const lastWaypoint = player.waypoints.length > 0 ? player.waypoints[player.waypoints.length - 1] : null;
  const startX = lastWaypoint?.x ?? points[0].lng;
  const startY = lastWaypoint?.y ?? points[0].lat;
  const distance = haversineDist({ lat: startY, lon: startX }, { lat: points[0].lat, lon: points[0].lng }) || 0;
  const walkingDuration = distance / BASE_SPEED;
  const walkingArrival = clockTime + walkingDuration;
  const departureTime = points[0].time;
  const waitArrival = departureTime - (1000 * 60); // 1 minute leeway

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
    const legSpeedLimit = legVirtualTime / 2000; // min 2 seconds for this leg
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
      waypointsToSubmit.push({
        x: points[i].lng,
        y: points[i].lat,
        arrivalTime: clockTime,
        speedFactor: 1,
        stopName: points[i].stopName,
        isInterstop: points[i].isInterstop,
        route_color: points[i].route_color,
        route_short_name: points[i].route_short_name,
        display_name: points[i].display_name,
        emoji: points[i].emoji,
        route_departure_time: points[i].route_departure_time,
        timeStr: points[i].timeStr
      });
    }
  } else {
    waypointsToSubmit.push({
      x: points[0].lng,
      y: points[0].lat,
      arrivalTime: walkingArrival,
      speedFactor: waypointSpeeds[0],
      stopName: points[0].stopName,
      isWalk: true,
      isInterstop: false,
      route_color: points[0].route_color,
      route_short_name: points[0].route_short_name,
      display_name: points[0].display_name,
      emoji: '🐾',
      route_departure_time: points[0].route_departure_time,
      timeStr: points[0].timeStr
    });

    if (waitArrival > walkingArrival) {
      waypointsToSubmit.push({
        x: points[0].lng,
        y: points[0].lat,
        arrivalTime: waitArrival,
        speedFactor: waypointSpeeds[0],
        stopName: `waiting for ${points[0].route_departure_time} ${points[0].route_short_name || ''}`.trim(),
        isWait: true,
        isInterstop: false,
        route_color: points[0].route_color,
        route_short_name: points[0].route_short_name,
        display_name: points[0].display_name,
        emoji: '⏳',
        route_departure_time: points[0].route_departure_time,
        timeStr: points[0].timeStr
      });
    }

    for (let i = 1; i < points.length; i++) {
      waypointsToSubmit.push({
        x: points[i].lng,
        y: points[i].lat,
        arrivalTime: points[i].time - (points[i].isInterstop ? 0 : (1000 * 60)),
        speedFactor: waypointSpeeds[i],
        stopName: points[i].stopName,
        isInterstop: points[i].isInterstop,
        route_color: points[i].route_color,
        route_short_name: points[i].route_short_name,
        display_name: points[i].display_name,
        emoji: points[i].emoji,
        route_departure_time: points[i].route_departure_time,
        timeStr: points[i].timeStr
      });
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

function processPlayer(raw: Player): RenderablePlayer {
  const segments: AnimationSegment[] = [];

  for (let i = 0; i < raw.waypoints.length; i++) {
    const wp = raw.waypoints[i];
    if (i > 0) {
      const prev = raw.waypoints[i - 1];
      segments.push({
        start: [prev.x, prev.y],
        end: [wp.x, wp.y],
        startTime: wp.startTime,
        endTime: wp.arrivalTime
      });
    }
  }

  return {
    ...raw,
    isGhost: raw.isGhost,
    segments
  };
}

export function setGameBounds(start: [number, number] | null, finish: [number, number] | null, startTime?: number, difficulty?: Difficulty, computerDriver?: boolean) {
  const currentDifficulty = difficulty || $gameBounds.get().difficulty;
  const currentComputerDriver = computerDriver !== undefined ? computerDriver : $gameBounds.get().computerDriver; // allow false (lol)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'SET_GAME_BOUNDS',
      startPos: start,
      finishPos: finish,
      startTime: startTime,
      difficulty: currentDifficulty,
      computerDriver: currentComputerDriver
    }));
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
