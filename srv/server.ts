import { serve, type ServerWebSocket } from "bun";
import {
  type Room,
  type GameHooks,
  updateRoomLogic,
  handleIncomingMessage,
  handleGameClose
} from "../src/shared/gameLogic";

type WSData = {
  roomId: string | null;
  playerId: string | null;
};

const rooms = new Map<string, Room>();

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
      console.log(`[Room: ${roomId}]: Deleted.`);
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
    console.log(`[Room: ${roomId}]: Deleted.`);
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
    rate: room.state === 'RUNNING' ? room.playbackRate : 0
  }));
}

function updateRoom(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  updateRoomLogic(room, getGameHooks(), updateRoom);
}

console.log(`Game Server listening on ${server.hostname}:${server.port}`);
