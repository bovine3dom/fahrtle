import {
    type Room,
    type GameHooks,
    updateRoomLogic,
    handleIncomingMessage,
    handleGameClose
} from "./shared/gameLogic";

class FakeWebSocket {
    onopen: ((this: any, ev: any) => any) | null = null;
    onmessage: ((this: any, ev: any) => any) | null = null;
    onclose: ((this: any, ev: any) => any) | null = null;
    readyState: number = WebSocket.OPEN;
    data: { roomId: string | null, playerId: string | null };
    private server: FakeServer;

    constructor(server: FakeServer, data: { roomId: string | null, playerId: string | null }) {
        this.server = server;
        this.data = data;
        setTimeout(() => this.onopen?.(null as any), 0);
    }

    send(msg: string) {
        this.server.handleMessage(this, msg);
    }

    close() {
        this.readyState = WebSocket.CLOSED;
        this.server.handleClose(this);
        setTimeout(() => this.onclose?.(null as any), 0);
    }
}

export class FakeServer {
    private rooms = new Map<string, Room>();
    private sockets = new Set<FakeWebSocket>();

    constructor() {
        // No-op
    }

    connect(_roomId: string, _playerId: string): FakeWebSocket {
        const ws = new FakeWebSocket(this, { roomId: null, playerId: null });
        this.sockets.add(ws);
        return ws;
    }

    handleMessage(ws: FakeWebSocket, msg: string) {
        const message = JSON.parse(msg);
        handleIncomingMessage(message, this.rooms, ws.data, this.getHooks(ws), (roomId: string) => this.updateRoom(roomId));
    }

    handleClose(ws: FakeWebSocket) {
        handleGameClose(this.rooms, ws.data, this.getHooks(ws));
        this.sockets.delete(ws);
    }

    private publish(roomId: string, message: any) {
        const msgString = JSON.stringify(message);
        for (const ws of this.sockets) {
            if (ws.data.roomId === roomId) {
                ws.onmessage?.({ data: msgString });
            }
        }
    }

    private getSubscriberCount(roomId: string): number {
        let count = 0;
        for (const ws of this.sockets) {
            if (ws.data.roomId === roomId) count++;
        }
        return count;
    }

    private broadcastRoomState(room: Room) {
        this.publish(room.id, {
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
        });
    }

    private updateRoom(roomId: string) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        updateRoomLogic(room, this.getHooks());
    }

    private getHooks(ws?: FakeWebSocket): GameHooks {
        return {
            broadcastRoomState: (room: Room) => this.broadcastRoomState(room),
            publish: (roomId: string, message: any) => this.publish(roomId, message),
            getSubscriberCount: (roomId: string) => this.getSubscriberCount(roomId),
            onRoomDeleted: (roomId: string) => {
                const room = this.rooms.get(roomId);
                if (room?.loopInterval) clearInterval(room.loopInterval);
                this.rooms.delete(roomId);
            },
            sendToSender: (messageValue: any) => {
                if (ws) {
                    ws.onmessage?.({ data: JSON.stringify(messageValue) });
                }
            },
            subscribeToRoom: (_roomId: string) => { /* No-op in fake server */ }
        };
    }
}

export const sharedFakeServer = new FakeServer();
