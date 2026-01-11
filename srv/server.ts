// ==> srv/server.ts <==
import { serve } from "bun";

type Waypoint = {
  x: number;
  y: number;
  startTime: number;   // Virtual Timestamp
  arrivalTime: number; // Virtual Timestamp
  speedFactor: number;
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

  // Time State
  virtualTime: number;
  lastRealTime: number;
  playbackRate: number;

  // Game Loop
  loopInterval: Timer;
};

const rooms = new Map<string, Room>();
const BASE_SPEED = 0.0001; // Degrees per Virtual Millisecond

// Helper: Distance
function dist(p1: { x: number, y: number }, p2: { x: number, y: number }) {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

const server = serve({
  port: 8080,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket Game Server", { status: 200 });
  },
  websocket: {
    open(ws) {
      ws.data = { roomId: null, playerId: null };
    },
    message(ws, msg) {
      const message = JSON.parse(String(msg));
      const now = Date.now();

      // --- SYNC ---
      if (message.type === 'SYNC_REQUEST') {
        const d = ws.data as any;

        // FIX: Check message.roomId (incoming request) OR d.roomId (socket session)
        const targetRoomId = message.roomId || d.roomId;

        let serverTime = now;
        let rate = 1.0;

        // Check if the room exists
        if (targetRoomId && rooms.has(targetRoomId)) {
          const r = rooms.get(targetRoomId)!;
          // Calculate precise virtual time at this instant
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
        const { roomId, playerId } = message;

        let room = rooms.get(roomId);
        if (!room) {
          // Initialize new room with a Game Loop
          room = {
            id: roomId,
            players: {},
            state: 'JOINING',
            countdownEnd: null,
            virtualTime: now,
            lastRealTime: now,
            playbackRate: 1.0,
            loopInterval: setInterval(() => updateRoom(roomId), 100) // 10 ticks/sec
          };
          rooms.set(roomId, room);
          console.log(`Created room ${roomId}`);
        }

        if (!room.players[playerId]) {
          room.players[playerId] = {
            id: playerId,
            color: '#' + Math.floor(Math.random() * 16777215).toString(16),
            isReady: room.state === 'RUNNING',
            // Initial position: Edinburgh, Scotland [-3.1883, 55.9533]
            waypoints: [{
              x: -3.1883,
              y: 55.9533,
              startTime: 0,
              arrivalTime: 0,
              speedFactor: 1
            }]
          };
        }

        const d = ws.data as any;
        d.roomId = roomId;
        d.playerId = playerId;

        ws.subscribe(roomId);

        // Send Initial State
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
        const d = ws.data as any;
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
        const d = ws.data as any;
        if (!d.roomId || !d.playerId) return;

        const room = rooms.get(d.roomId);
        if (!room || room.state !== 'RUNNING') return;
        const player = room.players[d.playerId];
        if (!player) return;

        // Force a clock update before math to ensure precision
        stepClock(room);

        const { x, y, speedFactor } = message;
        const lastPoint = player.waypoints[player.waypoints.length - 1];

        // Logic: When does this segment start?
        // If last point arrived in the past, we start NOW (Virtual Time).
        // If last point arrives in future, we queue it after that.
        let start = lastPoint.arrivalTime;
        if (start < room.virtualTime) {
          start = room.virtualTime;
        }

        const distance = dist(lastPoint, { x, y });

        // Waypoint Duration is derived from its specific speed factor
        // Note: This determines "Virtual Duration". 
        // Actual wall-clock time depends on the Room's global Playback Rate.
        const duration = distance / (BASE_SPEED * speedFactor);

        const newWaypoint: Waypoint = {
          x, y,
          startTime: start,
          arrivalTime: start + duration,
          speedFactor: speedFactor
        };

        player.waypoints.push(newWaypoint);

        server.publish(d.roomId, JSON.stringify({
          type: 'WAYPOINT_ADDED',
          playerId: d.playerId,
          waypoint: newWaypoint
        }));

        // Immediate update to adjust speed if this is the new slowest/fastest thing
        updateRoom(d.roomId);
      }
    },

    close(ws) {
      const d = ws.data as any;
      if (d.roomId && d.playerId) {
        const room = rooms.get(d.roomId);
        if (room) {
          delete room.players[d.playerId];
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_LEFT', playerId: d.playerId
          }));

          if (Object.keys(room.players).length === 0) {
            clearInterval(room.loopInterval);
            rooms.delete(d.roomId);
          }
        }
      }
    }
  }
});

// --- GAME LOOP ---
// Advances the virtual clock and determines global playback rate
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

  // Handle countdown completion
  if (room.state === 'COUNTDOWN' && room.countdownEnd && Date.now() >= room.countdownEnd) {
    room.state = 'RUNNING';
    room.countdownEnd = null;
    broadcastRoomState(room);
  }

  if (room.state !== 'RUNNING') return;

  // 1. Find the lowest speed factor among all ACTIVELY moving players
  let minSpeed = 1.0;
  let anyoneMoving = false;
  const activeFactors: number[] = [];

  const vTime = room.virtualTime;

  for (const pid in room.players) {
    const p = room.players[pid];
    let currentFactor = 1.0;
    for (const wp of p.waypoints) {
      if (vTime >= wp.startTime && vTime < wp.arrivalTime) {
        currentFactor = wp.speedFactor;
        anyoneMoving = true;
        break;
      }
    }
    activeFactors.push(currentFactor);
  }

  // "The clock should tick at the speed of the smallest random speedfactor"
  if (activeFactors.length > 0) {
    minSpeed = Math.min(...activeFactors);
  } else {
    // If no one is moving, revert to normal time? Or pause?
    // Let's revert to normal time so the clock feels responsive.
    minSpeed = 1.0;
  }

  // 2. If rate changed significantly, broadcast update
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
