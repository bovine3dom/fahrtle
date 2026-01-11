// ==> src/store.ts <==
import { atom, map } from 'nanostores';
import { syncClock } from './time-sync';

// --- Configuration ---
// (No global client-side constants needed for movement math anymore)

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
export const $departureBoardResults = atom<any[] | null>(null);
export const $roomState = atom<'JOINING' | 'COUNTDOWN' | 'RUNNING'>('JOINING');
export const $countdownEnd = atom<number | null>(null);
export const $clock = atom(0);

let ws: WebSocket | null = null;

// --- Actions ---

export function connectAndJoin(roomId: string, playerId: string, color?: string) {
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

    ws?.send(JSON.stringify({ type: 'JOIN_ROOM', roomId, playerId, color }));

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

  // 2. Set Speed Factor to Walking Speed (approx 5 km/h)
  const factor = 0.025;

  console.log(`[Store] Manual Waypoint: Walking at 2.5km/h (Factor: ${factor}x)`);

  ws.send(JSON.stringify({
    type: 'ADD_WAYPOINT',
    x: lng,
    y: lat,
    speedFactor: factor
  }));
}

export function submitWaypointsBatch(points: { lng: number, lat: number, time: number }[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const myId = $myPlayerId.get();
  const allPlayers = $players.get();
  const player = myId ? allPlayers[myId] : null;

  if (!player || points.length === 0) return;

  // 1. Calculate relative timings and distances
  let lastX = player.waypoints[player.waypoints.length - 1].x;
  let lastY = player.waypoints[player.waypoints.length - 1].y;
  let lastTime = $clock.get(); // Start from current game time

  const legs = [];
  let totalVirtualTime = 0;

  for (const p of points) {
    const d = Math.sqrt(Math.pow(p.lng - lastX, 2) + Math.pow(p.lat - lastY, 2));
    // Use the GTFS delta if possible, else a minimum 1s to avoid div/0
    const delta = Math.max(1000, p.time - lastTime);

    legs.push({ x: p.lng, y: p.lat, dist: d, delta });
    totalVirtualTime += delta;

    lastX = p.lng;
    lastY = p.lat;
    lastTime = p.time;
  }

  // 2. Solve for factor: VirtualDuration / factor = 30 seconds
  const targetRealTime = 30000;
  let M = totalVirtualTime / targetRealTime;
  if (M < 1.0) M = 1.0; // Respect 1x floor for realism

  console.log(`[Store] Trip: ${(totalVirtualTime / 60000).toFixed(1)} virtual minutes. Compressing with ${M.toFixed(2)}x rate to hit 30s real-time.`);

  // 3. Send waypoints with explicit arrival times
  let currentTime = $clock.get();
  for (const l of legs) {
    currentTime += l.delta; // Advance our target clock by the GTFS delta

    ws.send(JSON.stringify({
      type: 'ADD_WAYPOINT',
      x: l.x,
      y: l.y,
      arrivalTime: currentTime,
      speedFactor: M
    }));
  }
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
