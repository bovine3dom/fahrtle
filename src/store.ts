// ==> src/store.ts <==
import { atom, map } from 'nanostores';
import { syncClock } from './time-sync';
import { getTimeZone } from './timezone';
import { parseUserTime } from './utils/time';
import { throttle } from 'throttle-debounce';

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
};

export type Player = {
  id: string;
  color: string;
  isReady: boolean;
  waypoints: Waypoint[];
  renderableSegments?: AnimationSegment[];
  finishTime?: number;
  desiredRate?: number;
};

export type AnimationSegment = {
  start: [number, number];
  end: [number, number];
  startTime: number;
  endTime: number;
};

export type RenderablePlayer = Player & {
  segments: AnimationSegment[];
};

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
}

export const $connected = atom(false);
export const $currentRoom = atom<string | null>(null);
export const $myPlayerId = atom<string | null>(null);
export const $players = map<Record<string, RenderablePlayer>>({});
export const $globalRate = atom(1.0);
export const $departureBoardResults = atom<DepartureResult[]>([]);
export const $stopTimeZone = atom<string>('Europe/Paris');
export const $playerTimeZone = atom<string>('Europe/Paris');
export const $roomState = atom<'JOINING' | 'COUNTDOWN' | 'RUNNING'>('JOINING');
export const $countdownEnd = atom<number | null>(null);
export const $clock = atom(0);
export const $previewRoute = atom<[number, number][] | null>(null);
export const $boardMinimized = atom(false);
export const $isFollowing = atom(false);
export const $playerSpeeds = map<Record<string, number>>({});
export const $playerDistances = map<Record<string, number | null>>({});
export const $gameBounds = atom<{ start: [number, number] | null, finish: [number, number] | null, time?: number }>({ start: null, finish: null, time: undefined });
export const $pickerMode = atom<'start' | 'finish' | null>(null);
export const $pickedPoint = atom<{ lat: number, lng: number, target: 'start' | 'finish' } | null>(null);
export const $gameStartTime = atom<number | null>(null);

let ws: WebSocket | null = null;

export function connectAndJoin(roomId: string, playerId: string, color?: string, initialBounds?: { start: [number, number] | null, finish: [number, number] | null, time?: string }) {
  if (ws) ws.close();

  const wsUri = import.meta.env.PROD
    ? import.meta.env.VITE_FAHRTLE_WS_URI
    : 'ws://localhost:8080';
  ws = new WebSocket(wsUri);

  ws.onopen = () => {
    $connected.set(true);

    ws?.send(JSON.stringify({
      type: 'SYNC_REQUEST',
      clientSendTime: Date.now(),
      roomId: roomId
    }));

    ws?.send(JSON.stringify({ type: 'JOIN_ROOM', roomId, playerId, color }));

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
        startTime: startTime
      }));

      $gameBounds.set({
        start: initialBounds.start,
        finish: initialBounds.finish,
        time: startTime
      });
    }

    $currentRoom.set(roomId);
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
          }
        }
      }
      $players.set(renderables);
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
      $gameBounds.set({ start: msg.startPos, finish: msg.finishPos, time: msg.serverTime });
      $gameStartTime.set(msg.gameStartTime);
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50);
    }

    if (msg.type === 'ROOM_STATE_UPDATE') {
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
      $gameBounds.set({ start: msg.startPos, finish: msg.finishPos, time: msg.serverTime });
      $gameStartTime.set(msg.gameStartTime);
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
        const updatedPlayer = processPlayer({ ...p, waypoints: updatedWaypoints });
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

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
  route_departure_time?: string | null
}[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const player = $players.get()[$myPlayerId.get() ?? ''];
  if (!player || points.length === 0) return;

  const clockTime = $clock.get();
  let lastTime = clockTime;
  let totalVirtualTime = 0;

  for (const p of points) {
    totalVirtualTime += Math.max(1000, p.time - lastTime);
    lastTime = p.time;
  }

  const speedFactor = Math.max(1.0, totalVirtualTime / 30000);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    ws.send(JSON.stringify({
      type: 'ADD_WAYPOINT',
      x: p.lng,
      y: p.lat,
      arrivalTime: p.time,
      speedFactor,
      stopName: p.stopName,
      isWalk: i === 0,
      route_color: p.route_color,
      route_short_name: p.route_short_name,
      display_name: p.display_name,
      emoji: p.emoji,
      route_departure_time: p.route_departure_time
    }));
  }
}

export function leaveRoom() {
  if (ws) ws.close();
  $currentRoom.set(null);
  $players.set({});
}

const throttledSetColor = throttle(200, (color: string) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'UPDATE_PLAYER_COLOR', color }));
});

export function setPlayerColor(color: string) {
  throttledSetColor(color);
}

export function toggleReady() {
  ws?.send(JSON.stringify({ type: 'TOGGLE_READY' }));
}

export function toggleSnooze() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'TOGGLE_SNOOZE' }));
}

export function cancelNavigation() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not open, cannot cancel navigation');
    return;
  }

  ws.send(JSON.stringify({ type: 'CANCEL_NAVIGATION' }));
}

export function stopImmediately() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'STOP_IMMEDIATELY' }));
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

  return { ...raw, segments };
}

export function clearPreviewRoute() {
  $previewRoute.set(null);
}

export function setGameBounds(start: [number, number] | null, finish: [number, number] | null, startTime?: number) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'SET_GAME_BOUNDS',
      startPos: start,
      finishPos: finish,
      startTime: startTime
    }));
  }
}

export function finishRace(finishTime: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'PLAYER_FINISHED',
    finishTime: finishTime
  }));
}
