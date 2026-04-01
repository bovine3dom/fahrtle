import { Database } from "bun:sqlite";
import { serve, type ServerWebSocket } from "bun";
import {
  type Room,
  type GameHooks,
  type Waypoint,
  updateRoomLogic,
  handleIncomingMessage,
  handleGameClose,
  getRoomBounds,
  boundsToWire
} from "../src/shared/gameLogic";
import { calculateCO2Emissions } from "../src/utils/co2";

function log(...args: any[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

type GhostEntry = {
  playerId: string;
  playerName: string;
  color?: string;
  waypoints: string;
  finishTime: number;
  submittedAt: number;
};

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

const db = new Database("ghosts.db", { create: true });
db.exec("PRAGMA journal_mode = WAL;"); // improve write performance
db.run(`
  CREATE TABLE IF NOT EXISTS ghosts (
    raceIndex TEXT,
    playerId TEXT,
    version REAL DEFAULT 0.1,
    playerName TEXT,
    color TEXT,
    waypoints TEXT,
    finishTime REAL,
    submittedAt INTEGER,
    kgCO2e REAL,
    PRIMARY KEY(raceIndex, playerId, version)
  )
`);

const getGhostsQuery = db.prepare("SELECT * FROM ghosts WHERE raceIndex = ?");
const getLeaderboardQuery = db.prepare(`
  SELECT playerName, raceIndex, finishTime, kgCO2e
  FROM ghosts
  WHERE version = $version
  ORDER BY raceIndex ASC, finishTime ASC
`);
const upsertGhostQuery = db.prepare(`
  INSERT INTO ghosts (raceIndex, playerId, playerName, color, waypoints, finishTime, submittedAt, kgCO2e)
  VALUES ($raceIndex, $playerId, $playerName, $color, $waypoints, $finishTime, $submittedAt, $kgCO2e)
  ON CONFLICT(raceIndex, playerId, version) DO UPDATE SET
    playerName = $playerName,
    color = $color,
    waypoints = $waypoints,
    finishTime = $finishTime,
    submittedAt = $submittedAt,
    kgCO2e = $kgCO2e
  WHERE $finishTime < ghosts.finishTime
`);

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
        const rows = getGhostsQuery.all(raceIndex) as GhostEntry[];
        const ghosts = rows.map(g => ({
          ...g,
          waypoints: JSON.parse(g.waypoints) as Waypoint[]
        }));
        return new Response(JSON.stringify(ghosts), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (req.method === 'POST') {
        return req.json().then((body) => {
          const { playerId, playerName, color, waypoints, finishTime } = body;
          db.transaction(() => {
            upsertGhostQuery.run({
              $raceIndex: raceIndex,
              $playerId: playerId,
              $playerName: playerName,
              $color: color ?? null,
              $waypoints: JSON.stringify(waypoints),
              $finishTime: finishTime,
              $submittedAt: Date.now(),
              $kgCO2e: calculateCO2Emissions(waypoints)
            });
          })();
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
        });
      }


      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const leaderboardMatch = url.pathname.match(/^\/api\/leaderboard\/(\d+(\.\d+)?)$/);
    if (leaderboardMatch) {
      const version = leaderboardMatch[1];
      if (req.method === 'GET') {
        const rows = getLeaderboardQuery.all({ $version: parseFloat(version) }) as { playerName: string; raceIndex: string; finishTime: number }[];
        return new Response(JSON.stringify(rows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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
  const bounds = getRoomBounds(room);
  server.publish(room.id, JSON.stringify({
    type: 'ROOM_STATE_UPDATE',
    state: room.state,
    countdownEnd: room.countdownEnd,
    gameStartTime: room.gameStartTime,
    ...boundsToWire(bounds),
    serverTime: room.virtualTime,
    realTime: Date.now(),
    isRerun: room.isRerun,
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
