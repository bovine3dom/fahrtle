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
    private STORAGE_KEY = 'fahrtle_solo_state';

    constructor() {
        this.loadFromLocalStorage();
        setInterval(() => this.saveToLocalStorage(), 5000);
    }

    connect(_roomId: string, _playerId: string): FakeWebSocket {
        const ws = new FakeWebSocket(this, { roomId: null, playerId: null });
        this.sockets.add(ws);
        return ws;
    }

    handleMessage(ws: FakeWebSocket, msg: string) {
        const message = JSON.parse(msg);
        handleIncomingMessage(message, this.rooms, ws.data, this.getHooks(ws), (roomId: string) => this.updateRoom(roomId));
        this.saveToLocalStorage();
    }

    handleClose(ws: FakeWebSocket) {
        handleGameClose(this.rooms, ws.data, this.getHooks(ws));
        this.sockets.delete(ws);
        this.saveToLocalStorage();
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
                this.saveToLocalStorage();
            },
            sendToSender: (messageValue: any) => {
                if (ws) {
                    ws.onmessage?.({ data: JSON.stringify(messageValue) });
                }
            },
            subscribeToRoom: (_roomId: string) => { /* No-op in fake server */ }
        };
    }

    private saveToLocalStorage() {
        const data: Record<string, any> = {};
        for (const [id, room] of this.rooms) {
            // Don't serialize loopInterval
            const { loopInterval, ...serializableRoom } = room;
            data[id] = serializableRoom;
        }
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    }

    private loadFromLocalStorage() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                for (const id in data) {
                    const room = data[id] as Room;
                    room.lastRealTime = Date.now(); // Reset sync time
                    room.loopInterval = setInterval(() => this.updateRoom(id), 100);
                    this.rooms.set(id, room);
                }
            }
        } catch (e) {
            console.error("Failed to load fake server state", e);
        }
    }

    public clearState() {
        for (const room of this.rooms.values()) {
            if (room.loopInterval) clearInterval(room.loopInterval);
        }
        this.rooms.clear();
        localStorage.removeItem(this.STORAGE_KEY);
    }

    public hasPersistentGame(): boolean {
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (!stored) return false;
        try {
            const data = JSON.parse(stored);
            return Object.keys(data).length > 0;
        } catch {
            return false;
        }
    }
}

export const sharedFakeServer = new FakeServer();
