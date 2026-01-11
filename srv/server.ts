// ==> srv/server.ts <==
import { serve, type ServerWebSocket } from "bun";

type WSData = {
  roomId: string | null;
  playerId: string | null;
};

type Waypoint = {
  x: number;
  y: number;
  startTime: number;   // Virtual Timestamp
  arrivalTime: number; // Virtual Timestamp
  speedFactor: number;
  stopName?: string;
};

type Player = {
  id: string;
  color: string;
  isReady: boolean;
  waypoints: Waypoint[];
};

type Room = {
  id: string;
  players: Record<string, Player>;

  // Game State
  state: 'JOINING' | 'COUNTDOWN' | 'RUNNING';
  countdownEnd: number | null;
  emptySince: number | null; // For cleanup

  // Time State
  virtualTime: number;
  lastRealTime: number;
  playbackRate: number;

  // Game Loop
  loopInterval: ReturnType<typeof setInterval>;
};

const rooms = new Map<string, Room>();
const BASE_SPEED = 0.0000005;
// Degrees per Virtual Millisecond

// Helper: Distance
function dist(p1: { x: number, y: number }, p2: { x: number, y: number }) {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

const server = serve<WSData>({
  port: 8080,
  fetch(req: Request, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket Game Server", { status: 200 });
  },
  websocket: {
    open(ws: ServerWebSocket<WSData>) {
      ws.data = { roomId: null, playerId: null };
    },
    message(ws: ServerWebSocket<WSData>, msg: string | Uint8Array) {
      const message = JSON.parse(String(msg));
      const now = Date.now();

      // --- SYNC ---
      if (message.type === 'SYNC_REQUEST') {
        const d = ws.data;
        const targetRoomId = message.roomId || d.roomId;

        let serverTime = now;
        let rate = 1.0;

        if (targetRoomId && rooms.has(targetRoomId)) {
          const r = rooms.get(targetRoomId)!;
          const elapsed = now - r.lastRealTime;
          serverTime = r.virtualTime + (elapsed * r.playbackRate);
          rate = r.playbackRate;
        }

        ws.send(JSON.stringify({
          type: 'SYNC_RESPONSE',
          clientSendTime: message.clientSendTime,
          serverTime: serverTime,
          realTime: now,
          rate: (targetRoomId && rooms.get(targetRoomId)?.state === 'RUNNING') ? rate : 0
        }));
        return;
      }

      // --- JOIN ---
      if (message.type === 'JOIN_ROOM') {
        const { roomId, playerId, color } = message;

        let room = rooms.get(roomId);
        if (!room) {
          room = {
            id: roomId,
            players: {},
            state: 'JOINING',
            countdownEnd: null,
            emptySince: null,
            virtualTime: now,
            lastRealTime: now,
            playbackRate: 1.0,
            loopInterval: setInterval(() => updateRoom(roomId), 100)
          };
          rooms.set(roomId, room);
          console.log(`Created room ${roomId}`);
        }

        // Room is no longer empty
        room.emptySince = null;

        if (!room.players[playerId]) {
          const spreadMeters = 50;
          const latOffset = (Math.random() - 0.5) * 2 * (spreadMeters / 111111);
          const lngOffset = (Math.random() - 0.5) * 2 * (spreadMeters / (111111 * Math.cos(55.9533 * Math.PI / 180)));

          room.players[playerId] = {
            id: playerId,
            color: color || ('#' + Math.floor(Math.random() * 16777215).toString(16)),
            isReady: room.state === 'RUNNING',
            // Initial position: Edinburgh, Scotland [-3.1883, 55.9533]
            waypoints: [{
              x: -3.1883 + lngOffset,
              y: 55.9533 + latOffset,
              startTime: 0,
              arrivalTime: 0,
              speedFactor: 1
            }]
          };
        }

        ws.data.roomId = roomId;
        ws.data.playerId = playerId;

        ws.subscribe(roomId);

        ws.send(JSON.stringify({
          type: 'ROOM_STATE',
          state: room.state,
          countdownEnd: room.countdownEnd,
          serverTime: room.virtualTime,
          realTime: now,
          rate: room.state === 'RUNNING' ? room.playbackRate : 0,
          players: room.players
        }));

        ws.publish(roomId, JSON.stringify({
          type: 'PLAYER_JOINED',
          player: room.players[playerId]
        }));
      }

      // --- TOGGLE READY ---
      if (message.type === 'TOGGLE_READY') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        const player = room?.players[d.playerId];
        if (!room || !player) return;

        player.isReady = !player.isReady;

        server.publish(d.roomId, JSON.stringify({
          type: 'READY_UPDATE',
          playerId: d.playerId,
          isReady: player.isReady
        }));

        checkCountdown(room);
      }

      // --- ADD WAYPOINT ---
      if (message.type === 'ADD_WAYPOINT') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;

        const room = rooms.get(d.roomId);
        if (!room || room.state !== 'RUNNING') return;
        const player = room.players[d.playerId];
        if (!player) return;

        stepClock(room);

        const { x, y, speedFactor, arrivalTime, stopName } = message;
        const lastPoint = player.waypoints[player.waypoints.length - 1];

        let start = lastPoint.arrivalTime;
        if (start < room.virtualTime) {
          start = room.virtualTime;
        }

        let finalArrival = arrivalTime;
        if (finalArrival === undefined) {
          const distance = dist(lastPoint, { x, y });
          const duration = distance / (BASE_SPEED * speedFactor);
          finalArrival = start + duration;
        }

        const newWaypoint: Waypoint = {
          x, y,
          startTime: start,
          arrivalTime: finalArrival,
          speedFactor: speedFactor,
          stopName: stopName || undefined
        };

        player.waypoints.push(newWaypoint);

        server.publish(d.roomId, JSON.stringify({
          type: 'WAYPOINT_ADDED',
          playerId: d.playerId,
          waypoint: newWaypoint
        }));

        updateRoom(d.roomId);
      }

      // --- CANCEL NAVIGATION ---
      if (message.type === 'CANCEL_NAVIGATION') {
        const d = ws.data;
        console.log(`[Server] Received CANCEL_NAVIGATION from ${d.playerId}`);
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room) return;
        const player = room.players[d.playerId];
        if (!player) return;

        stepClock(room);
        const vTime = room.virtualTime;

        // Find the next waypoint (the one we are currently traveling towards)
        const nextWpIndex = player.waypoints.findIndex(wp => wp.arrivalTime > vTime);
        console.log(`[Server] VirtualTime: ${vTime}, NextWpIndex: ${nextWpIndex}, Total Waypoints: ${player.waypoints.length}`);

        if (nextWpIndex !== -1 && nextWpIndex < player.waypoints.length - 1) {
          console.log(`[Server] Truncating waypoints to index ${nextWpIndex}`);
          // Truncate path: Keep everything up to the next waypoint, discard the rest
          player.waypoints = player.waypoints.slice(0, nextWpIndex + 1);

          // Force update for all clients
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_JOINED', // Overwrite player state on clients
            player: player
          }));

          console.log(`[Player ${d.playerId}] Cancelled navigation. Stopping at next waypoint.`);
        } else {
          console.log(`[Server] No future waypoints to cancel or already at last waypoint.`);
        }
      }
    },

    close(ws: ServerWebSocket<WSData>) {
      const d = ws.data;
      if (d.roomId && d.playerId) {
        const room = rooms.get(d.roomId);
        if (room) {
          delete room.players[d.playerId];
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_LEFT', playerId: d.playerId
          }));

          if (Object.keys(room.players).length === 0) {
            console.log(`Room ${d.roomId} is empty. Starting 1-min cleanup timer.`);
            room.emptySince = Date.now();
          }
        }
      }
    }
  }
});

function stepClock(room: Room) {
  const now = Date.now();
  const elapsedReal = now - room.lastRealTime;
  if (room.state === 'RUNNING') {
    room.virtualTime += elapsedReal * room.playbackRate;
  }
  room.lastRealTime = now;
}

function checkCountdown(room: Room) {
  const pCount = Object.keys(room.players).length;
  const readyCount = Object.values(room.players).filter(p => p.isReady).length;
  const allReady = pCount > 0 && readyCount === pCount;

  if (room.state === 'JOINING' && allReady) {
    room.state = 'COUNTDOWN';
    room.countdownEnd = Date.now() + 5000;
    broadcastRoomState(room);
  } else if (room.state === 'COUNTDOWN' && !allReady) {
    room.state = 'JOINING';
    room.countdownEnd = null;
    broadcastRoomState(room);
  }
}

function broadcastRoomState(room: Room) {
  server.publish(room.id, JSON.stringify({
    type: 'ROOM_STATE_UPDATE',
    state: room.state,
    countdownEnd: room.countdownEnd,
    serverTime: room.virtualTime,
    realTime: Date.now(),
    rate: room.state === 'RUNNING' ? room.playbackRate : 0
  }));
}

function updateRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  stepClock(room);

  // 0. Cleanup check
  if (room.emptySince !== null) {
    const emptyDuration = Date.now() - room.emptySince;
    if (emptyDuration > 60000) { // 1 Minute
      console.log(`Killing room ${roomId} after 1 minute of emptiness.`);
      clearInterval(room.loopInterval);
      rooms.delete(roomId);
      return;
    }
  }

  // Handle countdown completion
  if (room.state === 'COUNTDOWN' && room.countdownEnd && Date.now() >= room.countdownEnd) {
    room.state = 'RUNNING';
    room.countdownEnd = null;
    broadcastRoomState(room);
  }

  if (room.state !== 'RUNNING') return;

  let minSpeed = 1.0;
  const activeFactors: number[] = [];
  const vTime = room.virtualTime;

  for (const pid in room.players) {
    const p = room.players[pid];
    let currentFactor = 1.0;
    for (const wp of p.waypoints) {
      if (vTime >= wp.startTime && vTime < wp.arrivalTime) {
        currentFactor = wp.speedFactor;
        break;
      }
    }
    activeFactors.push(currentFactor);
  }

  if (activeFactors.length > 0) {
    minSpeed = Math.max(1.0, Math.min(...activeFactors));
  } else {
    minSpeed = 1.0;
  }

  if (Math.abs(room.playbackRate - minSpeed) > 0.01) {
    console.log(`[Room ${roomId}] Adjusting Global Clock: ${minSpeed}x`);
    room.playbackRate = minSpeed;

    server.publish(roomId, JSON.stringify({
      type: 'CLOCK_UPDATE',
      serverTime: room.virtualTime,
      realTime: Date.now(),
      rate: room.playbackRate
    }));
  }
}

console.log(`Game Server listening on ${server.hostname}:${server.port}`);
