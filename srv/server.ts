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
  isWalk?: boolean;
  route_color?: string;
  route_short_name?: string;
  display_name?: string;
  emoji?: string;
  route_departure_time?: string;
};

type Player = {
  id: string;
  color: string;
  isReady: boolean;
  waypoints: Waypoint[];
  desiredRate: number; // 1.0 or 500.0
  finishTime: number | null;
  disconnectedAt: number | null;
};

type Room = {
  id: string;
  players: Record<string, Player>;

  // Game State
  state: 'JOINING' | 'COUNTDOWN' | 'RUNNING';
  countdownEnd: number | null;
  emptySince: number | null; // For cleanup
  gameStartTime: number | null;

  startPos: [number, number];
  finishPos: [number, number] | null;

  // Time State
  virtualTime: number;
  lastRealTime: number;
  playbackRate: number;

  // Game Loop
  loopInterval: ReturnType<typeof setInterval>;
};

const rooms = new Map<string, Room>();
const BASE_SPEED = 5 / (60 * 60 * 1000); // 5 km/h in km/ms

function logStats(message: string) {
  setTimeout(() => {
    let totalSubscribers = 0;
    for (const room of rooms.values()) {
      totalSubscribers += server.subscriberCount(room.id);
    }
    console.log(`${message} | Total players: ${totalSubscribers}`);
  }, 10); // tiny delay allows subscribers to actually subscribe
}

function haversineDist(coords1: { x: number, y: number }, coords2: { x: number, y: number }) {
  const toRad = (x: number) => x * Math.PI / 180;
  const R = 6371; // km
  const dLat = toRad(coords2.y - coords1.y);
  const dLon = toRad(coords2.x - coords1.x);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coords1.y)) * Math.cos(toRad(coords2.y)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function lerp(v0: number, v1: number, t: number) {
  return v0 * (1 - t) + v1 * t;
}

// Helper: Generate a random point within ~50m of a center
function getSpawnPoint(centerLat: number, centerLng: number) {
  const spreadMeters = 50;
  const latOffset = (Math.random() - 0.5) * 2 * (spreadMeters / 111111);
  const lngOffset = (Math.random() - 0.5) * 2 * (spreadMeters / (111111 * Math.cos(centerLat * Math.PI / 180)));

  return {
    x: centerLng + lngOffset,
    y: centerLat + latOffset
  };
}

const server = serve<WSData>({
  port: 8080,
  fetch(req: Request, server: any) {
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
            startPos: [55.9533, -3.1883], // Edinburgh, Scotland
            finishPos: [43.7101, 7.2660], // Nice, France
            emptySince: null,
            gameStartTime: null,
            virtualTime: now,
            lastRealTime: now,
            playbackRate: 1.0,
            loopInterval: setInterval(() => updateRoom(roomId), 100)
          };
          rooms.set(roomId, room);
          logStats(`[Room: ${roomId}]: New room created.`);
        }

        // Room is no longer empty
        room.emptySince = null;

        if (!room.players[playerId]) {
          const centerLat = room.startPos[0];
          const centerLng = room.startPos[1];

          const spawn = getSpawnPoint(centerLat, centerLng);

          room.players[playerId] = {
            id: playerId,
            color: color || ('#' + Math.floor(Math.random() * 16777215).toString(16)),
            isReady: room.state === 'RUNNING',
            waypoints: [{
              x: spawn.x,
              y: spawn.y,
              startTime: 0,
              arrivalTime: 0,
              speedFactor: 1
            }],
            desiredRate: 1.0,
            finishTime: null,
            disconnectedAt: null,
          };
        } else {
          // Player is re-joining
          room.players[playerId].disconnectedAt = null;
          room.players[playerId].desiredRate = 1.0;
        }

        logStats(`[Room: ${roomId}]: Player ${playerId} joined.`);

        ws.data.roomId = roomId;
        ws.data.playerId = playerId;

        ws.subscribe(roomId);

        ws.send(JSON.stringify({
          type: 'ROOM_STATE',
          state: room.state,
          countdownEnd: room.countdownEnd,
          gameStartTime: room.gameStartTime,
          serverTime: room.virtualTime,
          startPos: room.startPos,
          finishPos: room.finishPos,
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

      if (message.type === 'UPDATE_PLAYER_COLOR') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room) return;
        const player = room.players[d.playerId];
        if (player) {
          player.color = message.color;
          // Broadcast player update so all clients see the new color
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_JOINED',
            player: player
          }));
        }
      }

      if (message.type === 'TOGGLE_SNOOZE') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room) return;
        const player = room.players[d.playerId];
        if (player) {
          // Toggle between 1x and 500x
          player.desiredRate = player.desiredRate > 1.0 ? 1.0 : 500.0;
          updateRoom(d.roomId); // Immediate update

          // Broadcast player update so UI shows snooze state
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_JOINED',
            player: player
          }));
        }
      }

      if (message.type === 'SET_GAME_BOUNDS') {
        const d = ws.data;
        if (!d.roomId) return;
        const room = rooms.get(d.roomId);
        if (!room || room.state !== 'JOINING') return; // Only allow editing in lobby

        const prevStart = room.startPos;
        room.startPos = message.startPos; // Expecting [lat, lng] or null
        room.finishPos = message.finishPos;

        if (message.startTime) {
          room.virtualTime = message.startTime;
        }

        if (room.startPos) {
          const [newLat, newLng] = room.startPos;

          const posChanged = !prevStart || Math.abs(prevStart[0] - newLat) > 0.0001 || Math.abs(prevStart[1] - newLng) > 0.0001;
          const timeChanged = message.startTime !== undefined;

          if (posChanged || timeChanged) {
            for (const pid in room.players) {
              const p = room.players[pid];
              const spawn = getSpawnPoint(newLat, newLng);

              // Reset waypoints to the new start
              p.waypoints = [{
                x: spawn.x,
                y: spawn.y,
                startTime: room.virtualTime, // Use current virtual time
                arrivalTime: room.virtualTime,
                speedFactor: 1
              }];

              // Broadcast the update for this player
              server.publish(d.roomId, JSON.stringify({
                type: 'PLAYER_JOINED', // Reuse JOINED as "Update Full Player State"
                player: p
              }));
            }
          }
        }

        broadcastRoomState(room);
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

        const { x, y, speedFactor, arrivalTime, stopName, isWalk, route_color, route_short_name, display_name, emoji, route_departure_time } = message;
        const lastPoint = player.waypoints[player.waypoints.length - 1];

        let start = lastPoint.arrivalTime;
        if (start < room.virtualTime) {
          start = room.virtualTime;
        }

        let finalArrival = arrivalTime;
        if (finalArrival === undefined) {
          const distance = haversineDist(lastPoint, { x, y });
          const duration = distance / BASE_SPEED;
          finalArrival = start + duration;
        }

        const newWaypoint: Waypoint = {
          x, y,
          startTime: start,
          arrivalTime: finalArrival,
          speedFactor: speedFactor,
          stopName: stopName || undefined,
          isWalk: isWalk || false,
          route_color,
          route_short_name,
          display_name,
          emoji: isWalk ? '🐾' : emoji,
          route_departure_time
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

        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room) return;
        const player = room.players[d.playerId];
        if (!player) return;

        stepClock(room);
        const vTime = room.virtualTime;

        // Find the next waypoint (the one we are currently traveling towards)
        const nextWpIndex = player.waypoints.findIndex(wp => wp.arrivalTime > vTime);

        if (nextWpIndex !== -1 && nextWpIndex < player.waypoints.length - 1) {
          // Truncate path: Keep everything up to the next waypoint, discard the rest
          player.waypoints = player.waypoints.slice(0, nextWpIndex + 1);

          // Force update for all clients
          server.publish(d.roomId, JSON.stringify({
            type: 'PLAYER_JOINED', // Overwrite player state on clients
            player: player
          }));
        }
      }

      if (message.type === 'STOP_IMMEDIATELY') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room) return;
        const player = room.players[d.playerId];
        if (!player) return;

        stepClock(room);
        const vTime = room.virtualTime;

        let currentPos = { x: player.waypoints[0].x, y: player.waypoints[0].y };
        const nextWpIndex = player.waypoints.findIndex(wp => wp.arrivalTime > vTime);

        if (nextWpIndex !== -1) {
          const nextWp = player.waypoints[nextWpIndex];
          const prevWp = player.waypoints[nextWpIndex - 1] || player.waypoints[0];
          const segStartTime = Math.max(prevWp.arrivalTime, nextWp.startTime);
          const duration = nextWp.arrivalTime - segStartTime;
          if (duration > 0 && vTime > segStartTime) {
            const t = (vTime - segStartTime) / duration;
            currentPos.x = lerp(prevWp.x, nextWp.x, t);
            currentPos.y = lerp(prevWp.y, nextWp.y, t);
          } else if (vTime >= nextWp.arrivalTime) {
            currentPos.x = nextWp.x;
            currentPos.y = nextWp.y;
          } else {
            currentPos.x = prevWp.x;
            currentPos.y = prevWp.y;
          }
        } else {
          const last = player.waypoints[player.waypoints.length - 1];
          currentPos.x = last.x;
          currentPos.y = last.y;
        }

        if (nextWpIndex !== -1) {
          const nextWp = player.waypoints[nextWpIndex];
          const prevWp = player.waypoints[nextWpIndex - 1] || player.waypoints[0];
          const segStartTime = Math.max(prevWp.arrivalTime, nextWp.startTime);

          player.waypoints = [
            ...player.waypoints.slice(0, nextWpIndex),
            {
              x: currentPos.x,
              y: currentPos.y,
              startTime: segStartTime,
              arrivalTime: vTime,
              speedFactor: 1,
              stopName: 'Stopped',
              // emoji: '🛑'
            }
          ];
        } else {
          const last = player.waypoints[player.waypoints.length - 1];
          if (last) {
            last.stopName = 'Stopped';
            last.arrivalTime = Math.min(last.arrivalTime, vTime);
          }
        }

        server.publish(d.roomId, JSON.stringify({
          type: 'PLAYER_JOINED',
          player: player
        }));
      }

      if (message.type === 'PLAYER_FINISHED') {
        const d = ws.data;
        if (!d.roomId || !d.playerId) return;
        const room = rooms.get(d.roomId);
        if (!room || room.state !== 'RUNNING') return;

        const player = room.players[d.playerId];
        if (!player || player.finishTime) return; // Ignore if already finished
        player.finishTime = message.finishTime;
        console.log(`[Room: ${d.roomId}]: Player ${d.playerId} finished.`);

        server.publish(d.roomId, JSON.stringify({
          type: 'PLAYER_JOINED',
          player: player
        }));
      }
    },

    close(ws: ServerWebSocket<WSData>) {
      const d = ws.data;
      if (d.roomId && d.playerId) {
        const room = rooms.get(d.roomId);
        if (room) {
          const player = room.players[d.playerId];
          if (player) {
            player.disconnectedAt = Date.now();

            const roomConnections = server.subscriberCount(d.roomId);
            if (roomConnections > 0) {
              player.desiredRate = 500.0;
              server.publish(d.roomId, JSON.stringify({
                type: 'PLAYER_JOINED',
                player: player
              }));
            } else {
              room.emptySince = Date.now();
              room.playbackRate = 0;
            }
            logStats(`[Room: ${d.roomId}]: Player ${d.playerId} disconnected.`);
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
    gameStartTime: room.gameStartTime,
    startPos: room.startPos,
    finishPos: room.finishPos,
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
      logStats(`[Room: ${roomId}]: Killed room after 1 minute of emptiness.`);
      clearInterval(room.loopInterval);
      rooms.delete(roomId);
      return;
    }
  }

  for (const pid in room.players) {
    const p = room.players[pid];
    if (p.disconnectedAt && Date.now() - p.disconnectedAt > 60000) {
      delete room.players[pid];
      server.publish(roomId, JSON.stringify({
        type: 'PLAYER_LEFT',
        playerId: pid
      }));
      logStats(`[Room: ${roomId}]: Kicking player ${pid} after 1 minute disconnect.`);
      checkCountdown(room);
    }
  }

  // Handle countdown completion
  if (room.state === 'COUNTDOWN' && room.countdownEnd && Date.now() >= room.countdownEnd) {
    room.state = 'RUNNING';
    room.gameStartTime = room.virtualTime;
    room.countdownEnd = null;
    broadcastRoomState(room);
  }

  if (room.state !== 'RUNNING') return;

  const subscriberCount = server.subscriberCount(roomId);
  if (subscriberCount === 0) {
    if (room.playbackRate !== 0) {
      room.playbackRate = 0;
      broadcastRoomState(room); // (🌲 -> 🪵) && 🚫👂 ? 🔊 : 🔇
    }
    return;
  }

  let minSpeed = 1.0;
  const activeFactors: number[] = [];
  const vTime = room.virtualTime;

  for (const pid in room.players) {
    const p = room.players[pid];
    let currentFactor = p.desiredRate || 1.0;

    for (const wp of p.waypoints) {
      if (vTime >= wp.startTime && vTime < wp.arrivalTime) {
        // Effective speed is max of trip requirement vs desire
        currentFactor = Math.max(wp.speedFactor, p.desiredRate || 1.0);
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
