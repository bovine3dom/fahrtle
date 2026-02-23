import { serve, type ServerWebSocket } from "bun";
import {
  type Room,
  type GameHooks,
  type Waypoint,
  updateRoomLogic,
  handleIncomingMessage,
  handleGameClose
} from "../src/shared/gameLogic";

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

type GhostEntry = {
  playerId: string;
  playerName: string;
  waypoints: Waypoint[];
  finishTime: number;
  submittedAt: number;
};

const ghostsByRaceIndex = new Map<string, GhostEntry[]>();

type WSData = {
  roomId: string | null;
  playerId: string | null;
};

const rooms = new Map<string, Room>();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = serve<WSData>({
  port: 8080,
  fetch(req: Request, server: any) {
    if (server.upgrade(req)) return;

    const url = new URL(req.url);
    const pathMatch = url.pathname.match(/^\/api\/ghosts\/(\d+)$/);

    if (pathMatch) {
      const raceIndex = pathMatch[1];

      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      if (req.method === 'GET') {
        const ghosts = ghostsByRaceIndex.get(raceIndex) || [];
        return new Response(JSON.stringify(ghosts), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (req.method === 'POST') {
        return req.json().then((body: { playerId: string; playerName: string; waypoints: Waypoint[]; finishTime: number }) => {
          const { playerId, playerName, waypoints, finishTime } = body;

          if (!playerId || !waypoints || !finishTime) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: corsHeaders });
          }

          if (!ghostsByRaceIndex.has(raceIndex)) {
            ghostsByRaceIndex.set(raceIndex, []);
          }

          const ghosts = ghostsByRaceIndex.get(raceIndex)!;
          const existingIdx = ghosts.findIndex(g => g.playerId === playerId);

          const newEntry: GhostEntry = {
            playerId,
            playerName,
            waypoints: waypoints,
            finishTime,
            submittedAt: Date.now()
          };

          if (existingIdx === -1) {
            ghosts.push(newEntry);
          } else if (finishTime < ghosts[existingIdx].finishTime) {
            ghosts[existingIdx] = newEntry;
          }

          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        }).catch(() => {
          return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
        });
      }

      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    return new Response("WebSocket Game Server", { status: 200 });
  },
  websocket: {
    open(ws: ServerWebSocket<WSData>) {
      ws.data = { roomId: null, playerId: null };
    },
    message(ws: ServerWebSocket<WSData>, msg: string | Uint8Array) {
      const message = JSON.parse(String(msg));
      handleIncomingMessage(message, rooms, ws.data, getwsHooks(ws), updateRoom);
    },
    close(ws: ServerWebSocket<WSData>) {
      handleGameClose(rooms, ws.data, getwsHooks(ws), updateRoom);
    }
  }
});

function getwsHooks(ws: ServerWebSocket<WSData>): GameHooks {
  return {
    broadcastRoomState: (room: Room) => broadcastRoomState(room),
    publish: (roomId: string, message: any) => server.publish(roomId, JSON.stringify(message)),
    getSubscriberCount: (roomId: string) => server.subscriberCount(roomId),
    onRoomDeleted: (roomId: string) => {
      rooms.delete(roomId);
      process.stdout.write('\n'); // don't overwrite status line
      log(`Room: ${roomId}: Deleted.`);
    },
    sendToSender: (message: any) => ws.send(JSON.stringify(message)),
    subscribeToRoom: (roomId: string) => ws.subscribe(roomId)
  };
}

const gameHooks: GameHooks = {
  broadcastRoomState: (room: Room) => broadcastRoomState(room),
  publish: (roomId: string, message: any) => server.publish(roomId, JSON.stringify(message)),
  getSubscriberCount: (roomId: string) => server.subscriberCount(roomId),
  onRoomDeleted: (roomId: string) => {
    rooms.delete(roomId);
    process.stdout.write('\n');
    log(`Room: ${roomId}: Deleted.`);
  },
  sendToSender: () => { /* Server root doesn't have a specific sender */ },
  subscribeToRoom: () => { /* Server root doesn't subscribe */ }
};

function getGameHooks(): GameHooks {
  return gameHooks;
}

function broadcastRoomState(room: Room) {
  server.publish(room.id, JSON.stringify({
    type: 'ROOM_STATE_UPDATE',
    state: room.state,
    countdownEnd: room.countdownEnd,
    gameStartTime: room.gameStartTime,
    startPos: room.startPos,
    finishPos: room.finishPos,
    difficulty: room.difficulty,
    serverTime: room.virtualTime,
    realTime: Date.now(),
    isRerun: room.isRerun,
    computerDriver: room.computerDriver,
    ghosts: room.ghosts,
    rate: room.state === 'RUNNING' ? room.playbackRate : 0
  }));
}

function updateRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  updateRoomLogic(room, getGameHooks(), updateRoom);
}

setInterval(() => {
  let totalPlayers = 0;
  for (const room of rooms.values()) {
    totalPlayers += server.subscriberCount(room.id);
  }
  const timestamp = new Date().toLocaleTimeString();
  // \r moves cursor to start of line, \x1b[K clears the rest of the line
  const statusLine = `\r[${timestamp}] Active Rooms: ${rooms.size} | Total Players: ${totalPlayers}\x1b[K`;
  process.stdout.write(statusLine);
}, 60000);

log(`Game Server listening on ${server.hostname}:${server.port}`);
