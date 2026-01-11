// ==> src/store.ts <==
import { atom, map } from 'nanostores';
import { syncClock } from './time-sync';

// --- Configuration ---
// Must match the server's BASE_SPEED
const BASE_SPEED = 0.0001;
// The target duration for every leg (30 seconds)
const TARGET_DURATION_MS = 30000;

// --- Types ---
export type Waypoint = {
  x: number;
  y: number;
  startTime: number;
  arrivalTime: number;
  speedFactor: number;
};

export type Player = {
  id: string;
  color: string;
  isReady: boolean;
  waypoints: Waypoint[];
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

// --- State ---
export const $connected = atom(false);
export const $currentRoom = atom<string | null>(null);
export const $myPlayerId = atom<string | null>(null);
export const $players = map<Record<string, RenderablePlayer>>({});
export const $globalRate = atom(1.0);
export const $roomState = atom<'JOINING' | 'COUNTDOWN' | 'RUNNING'>('JOINING');
export const $countdownEnd = atom<number | null>(null);

let ws: WebSocket | null = null;

// --- Actions ---

export function connectAndJoin(roomId: string, playerId: string) {
  if (ws) ws.close();

  ws = new WebSocket('ws://localhost:8080');

  ws.onopen = () => {
    $connected.set(true);

    // FIX: Send roomId with the sync request so server knows which clock to read
    ws?.send(JSON.stringify({
      type: 'SYNC_REQUEST',
      clientSendTime: Date.now(),
      roomId: roomId
    }));

    ws?.send(JSON.stringify({ type: 'JOIN_ROOM', roomId, playerId }));

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
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50); // Assume 50ms latency for broadcast
      $globalRate.set(msg.rate);
    }

    if (msg.type === 'ROOM_STATE') {
      const renderables: Record<string, RenderablePlayer> = {};
      for (const pid in msg.players) {
        renderables[pid] = processPlayer(msg.players[pid]);
      }
      $players.set(renderables);
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
      syncClock(msg.serverTime, msg.realTime || Date.now(), msg.rate, 50);
    }

    if (msg.type === 'ROOM_STATE_UPDATE') {
      $roomState.set(msg.state);
      $countdownEnd.set(msg.countdownEnd);
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

  // 1. Get the last known position (or spawn point)
  const lastPoint = player.waypoints[player.waypoints.length - 1];

  // 2. Calculate Distance (Euclidean degrees)
  // Matches server logic: dist = sqrt(dx^2 + dy^2)
  const dist = Math.sqrt(
    Math.pow(lng - lastPoint.x, 2) + Math.pow(lat - lastPoint.y, 2)
  );

  // 3. Calculate Speed Factor
  // Formula: Duration = Distance / (BASE_SPEED * Factor)
  // Therefore: Factor = Distance / (BASE_SPEED * Duration)
  let factor = dist / (BASE_SPEED * TARGET_DURATION_MS);

  // Safety Clamp: Don't let time stop completely on double-clicks
  if (factor < 0.05) factor = 0.05;

  console.log(`[Store] Trip: ${(dist * 111).toFixed(2)}km. Factor: ${factor.toFixed(3)}x`);

  ws.send(JSON.stringify({
    type: 'ADD_WAYPOINT',
    x: lng,
    y: lat,
    speedFactor: factor
  }));
}

export function leaveRoom() {
  if (ws) ws.close();
  $currentRoom.set(null);
  $players.set({});
}

export function toggleReady() {
  ws?.send(JSON.stringify({ type: 'TOGGLE_READY' }));
}

// --- Helper: Convert Points to Time Segments ---
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
