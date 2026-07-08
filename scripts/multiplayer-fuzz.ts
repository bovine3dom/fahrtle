import {
  boundsToWire,
  getRoomBounds,
  handleGameClose,
  handleIncomingMessage,
  updateRoomLogic,
  type Difficulty,
  type GameHooks,
  type Room,
  type Waypoint,
} from '../src/shared/gameLogic';

type WsData = { roomId: string | null; playerId: string | null };

type Client = {
  id: string;
  playerId: string;
  roomId: string;
  connected: boolean;
  wsData: WsData;
  inbox: unknown[];
};

type TraceEntry = {
  step: number;
  at: number;
  action: string;
  client?: string;
  message?: unknown;
};

type Options = {
  seed: number;
  steps: number;
  clients: number;
  rooms: number;
  hostile: boolean;
  traceLimit: number;
};

class FuzzFailure extends Error {
  constructor(message: string, readonly trace: TraceEntry[]) {
    super(message);
    this.name = 'FuzzFailure';
  }
}

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next() {
    this.state += 0x6d2b79f5;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number) {
    return Math.floor(this.next() * maxExclusive);
  }

  bool(probability = 0.5) {
    return this.next() < probability;
  }

  pick<T>(items: T[]): T {
    if (items.length === 0) throw new Error('Cannot pick from empty list');
    return items[this.int(items.length)];
  }
}

class FakeClock {
  nowMs = 1700000000000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, delay: number) {
    const id = this.nextId++;
    const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    this.timers.set(id, { at: this.nowMs + safeDelay, fn });
    return id;
  }

  clearTimeout(id: number) {
    this.timers.delete(id);
  }

  hasTimer(id: unknown) {
    return typeof id === 'number' && this.timers.has(id);
  }

  activeTimerCount() {
    return this.timers.size;
  }

  advance(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid clock advance: ${ms}`);
    this.nowMs += ms;
    this.runDueTimers();
  }

  runDueTimers(maxRuns = 1000) {
    let runs = 0;
    while (runs < maxRuns) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers.entries()) {
        if (entry[1].at <= this.nowMs && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].fn();
      runs++;
    }
    throw new Error(`Timer loop exceeded ${maxRuns} callbacks`);
  }
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    seed: Date.now() >>> 0,
    steps: 1000,
    clients: 4,
    rooms: 2,
    hostile: false,
    traceLimit: 80,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--seed' && next) {
      options.seed = Number(next) >>> 0;
      i++;
    } else if (arg === '--steps' && next) {
      options.steps = Number(next);
      i++;
    } else if (arg === '--clients' && next) {
      options.clients = Number(next);
      i++;
    } else if (arg === '--rooms' && next) {
      options.rooms = Number(next);
      i++;
    } else if (arg === '--trace-limit' && next) {
      options.traceLimit = Number(next);
      i++;
    } else if (arg === '--hostile') {
      options.hostile = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.steps) || options.steps < 1) throw new Error('--steps must be a positive integer');
  if (!Number.isInteger(options.clients) || options.clients < 1) throw new Error('--clients must be a positive integer');
  if (!Number.isInteger(options.rooms) || options.rooms < 1) throw new Error('--rooms must be a positive integer');
  if (!Number.isInteger(options.traceLimit) || options.traceLimit < 1) throw new Error('--trace-limit must be a positive integer');
  return options;
}

function printHelp() {
  console.log(`Usage: bun run scripts/multiplayer-fuzz.ts [options]\n\nOptions:\n  --seed <n>         Seed for deterministic reproduction\n  --steps <n>        Number of random actions to run (default: 1000)\n  --clients <n>      Number of simulated clients (default: 4)\n  --rooms <n>        Number of possible room ids (default: 2)\n  --hostile          Include malformed/adversarial protocol messages\n  --trace-limit <n>  Number of recent trace entries to print on failure\n`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function formatJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) return String(item);
    return item;
  });
}

class MultiplayerFuzzer {
  private readonly rooms = new Map<string, Room>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly clients: Client[];
  private readonly trace: TraceEntry[] = [];
  private currentStep = 0;

  constructor(
    private readonly options: Options,
    private readonly rng: Rng,
    private readonly clock: FakeClock,
  ) {
    this.clients = Array.from({ length: options.clients }, (_unused, index) => ({
      id: `client-${index}`,
      playerId: `player-${index}`,
      roomId: `room-${index % options.rooms}`,
      connected: false,
      wsData: { roomId: null, playerId: null },
      inbox: [],
    }));
  }

  run() {
    for (this.currentStep = 0; this.currentStep < this.options.steps; this.currentStep++) {
      try {
        this.runAction();
        this.assertInvariants();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new FuzzFailure(`Step ${this.currentStep}: ${message}`, this.recentTrace());
      }
    }
  }

  private runAction() {
    const available = this.availableActions();
    const action = this.rng.pick(available);
    action();
  }

  private availableActions(): Array<() => void> {
    const actions: Array<() => void> = [
      () => this.advanceTime(),
      () => this.connectOrReconnect(),
      () => this.sendSyncRequest(),
    ];

    if (this.joinedClients().length > 0) {
      actions.push(
        () => this.setGameBounds(),
        () => this.toggleReady(),
        () => this.toggleSnooze(),
        () => this.forceRealtime(),
        () => this.setViewingStop(),
        () => this.sendPing(),
        () => this.disconnect(),
        () => this.addGhosts(),
        () => this.kickGhost(),
      );
    }

    if (this.routingClients().length > 0) {
      actions.push(
        () => this.addWaypoint(),
        () => this.addWaypointsBatch(),
        () => this.stopImmediately(),
        () => this.finishPlayer(),
      );
    }

    if (this.finishedClients().length > 0) {
      actions.push(() => this.raceAgain());
    }

    if (this.options.hostile && this.connectedClients().length > 0) {
      actions.push(() => this.sendHostileMessage());
    }

    return actions;
  }

  private hooksFor(client?: Client): GameHooks {
    return {
      broadcastRoomState: (room) => {
        const bounds = getRoomBounds(room);
        this.publish(room.id, {
          type: 'ROOM_STATE_UPDATE',
          state: room.state,
          countdownEnd: room.countdownEnd,
          gameStartTime: room.gameStartTime,
          ...boundsToWire(bounds),
          serverTime: room.virtualTime,
          realTime: Date.now(),
          isRerun: room.isRerun,
          rate: room.state === 'RUNNING' ? room.playbackRate : 0,
        });
      },
      publish: (roomId, message) => this.publish(roomId, message),
      getSubscriberCount: (roomId) => this.subscriberCount(roomId),
      onRoomDeleted: (roomId) => {
        this.rooms.delete(roomId);
        this.subscriptions.delete(roomId);
      },
      sendToSender: (message) => {
        if (client?.connected) client.inbox.push(clone(message));
      },
      subscribeToRoom: (roomId) => {
        if (!client?.connected) return;
        let subscribers = this.subscriptions.get(roomId);
        if (!subscribers) {
          subscribers = new Set<string>();
          this.subscriptions.set(roomId, subscribers);
        }
        subscribers.add(client.id);
      },
      shouldDeletePlayer: (_roomId, playerId) => !this.clients.some((c) => c.connected && c.wsData.playerId === playerId),
    };
  }

  private updateRoom = (roomId: string) => {
    const room = this.rooms.get(roomId);
    if (!room) return;
    updateRoomLogic(room, this.hooksFor(), this.updateRoom);
  };

  private publish(roomId: string, message: unknown) {
    for (const clientId of this.subscriptions.get(roomId) ?? []) {
      const client = this.clients.find((candidate) => candidate.id === clientId);
      if (client?.connected) client.inbox.push(clone(message));
    }
  }

  private subscriberCount(roomId: string) {
    let count = 0;
    for (const clientId of this.subscriptions.get(roomId) ?? []) {
      if (this.clients.find((client) => client.id === clientId)?.connected) count++;
    }
    return count;
  }

  private send(client: Client, message: unknown, action: string) {
    this.record({ action, client: client.id, message });
    handleIncomingMessage(message, this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
  }

  private record(entry: Omit<TraceEntry, 'step' | 'at'>) {
    this.trace.push({ step: this.currentStep, at: this.clock.nowMs, ...entry });
  }

  private recentTrace() {
    return this.trace.slice(-this.options.traceLimit);
  }

  private connectedClients() {
    return this.clients.filter((client) => client.connected);
  }

  private joinedClients() {
    return this.clients.filter((client) => client.connected && client.wsData.roomId && client.wsData.playerId && this.rooms.get(client.wsData.roomId)?.players[client.wsData.playerId]);
  }

  private runningClients() {
    return this.joinedClients().filter((client) => this.rooms.get(client.wsData.roomId!)?.state === 'RUNNING');
  }

  private routingClients() {
    return this.runningClients().filter((client) => {
      const room = this.rooms.get(client.wsData.roomId!);
      const player = room?.players[client.wsData.playerId!];
      return player && !player.finishTime;
    });
  }

  private finishedClients() {
    return this.runningClients().filter((client) => {
      const room = this.rooms.get(client.wsData.roomId!);
      const player = room?.players[client.wsData.playerId!];
      return !!player?.finishTime && player.waypoints.length > 1;
    });
  }

  private connectOrReconnect() {
    const candidates = this.clients.filter((client) => !client.connected || !client.wsData.roomId);
    const client = candidates.length > 0 ? this.rng.pick(candidates) : this.rng.pick(this.clients);

    if (client.connected && client.wsData.roomId) return this.sendSyncRequest();

    client.connected = true;
    client.wsData = { roomId: null, playerId: null };
    client.inbox = [];
    this.send(client, {
      type: 'JOIN_ROOM',
      roomId: client.roomId,
      playerId: client.playerId,
      color: this.colorFor(client),
    }, 'JOIN_ROOM');
  }

  private sendSyncRequest() {
    const client = this.rng.pick(this.connectedClientsOrConnect());
    this.send(client, { type: 'SYNC_REQUEST', clientSendTime: this.clock.nowMs, roomId: client.wsData.roomId ?? client.roomId }, 'SYNC_REQUEST');
  }

  private setGameBounds() {
    const candidates = this.joinedClients().filter((client) => this.rooms.get(client.wsData.roomId!)?.state === 'JOINING');
    if (candidates.length === 0) return this.advanceTime();
    const client = this.rng.pick(candidates);
    const start: [number, number] = [this.coord(-60, 75), this.coord(-170, 170)];
    const finish: [number, number] = [this.coord(-60, 75), this.coord(-170, 170)];
    const difficulties: Difficulty[] = ['Easy', 'Normal', 'Transport nerd'];
    this.send(client, {
      type: 'SET_GAME_BOUNDS',
      startPos: start,
      finishPos: finish,
      startTime: this.clock.nowMs + this.rng.int(12 * 60 * 60 * 1000),
      difficulty: this.rng.pick(difficulties),
      computerDriver: false,
      ghosts: this.rng.bool(0.3),
      league: this.rng.bool(0.5) ? '20260706' : '20260218',
    }, 'SET_GAME_BOUNDS');
  }

  private toggleReady() {
    const candidates = this.joinedClients().filter((client) => this.rooms.get(client.wsData.roomId!)?.state !== 'RUNNING');
    if (candidates.length === 0) return this.advanceTime();
    this.send(this.rng.pick(candidates), { type: 'TOGGLE_READY' }, 'TOGGLE_READY');
  }

  private toggleSnooze() {
    this.send(this.rng.pick(this.joinedClients()), { type: 'TOGGLE_SNOOZE' }, 'TOGGLE_SNOOZE');
  }

  private forceRealtime() {
    this.send(this.rng.pick(this.joinedClients()), { type: 'FORCE_REALTIME' }, 'FORCE_REALTIME');
  }

  private setViewingStop() {
    this.send(this.rng.pick(this.joinedClients()), { type: 'SET_VIEWING_STOP', stopName: `stop-${this.rng.int(100)}` }, 'SET_VIEWING_STOP');
  }

  private sendPing() {
    this.send(this.rng.pick(this.joinedClients()), { type: 'SEND_PING', lat: this.coord(-85, 85), lon: this.coord(-180, 180) }, 'SEND_PING');
  }

  private disconnect() {
    const client = this.rng.pick(this.connectedClients());
    this.record({ action: 'DISCONNECT', client: client.id });
    client.connected = false;
    for (const subscribers of this.subscriptions.values()) subscribers.delete(client.id);
    handleGameClose(this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
  }

  private addWaypoint() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const waypoint = this.nextWaypointFor(client);
    this.send(client, { type: 'ADD_WAYPOINT', ...waypoint }, 'ADD_WAYPOINT');
  }

  private addWaypointsBatch() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const waypoints: Array<Omit<Waypoint, 'startTime'>> = [];
    const count = 1 + this.rng.int(4);
    let base = this.nextWaypointFor(client);
    waypoints.push(base);
    for (let i = 1; i < count; i++) {
      base = this.nextWaypointAfter(base);
      waypoints.push(base);
    }
    this.send(client, { type: 'ADD_WAYPOINTS_BATCH', waypoints }, 'ADD_WAYPOINTS_BATCH');
  }

  private stopImmediately() {
    const candidates = this.routingClients().filter((client) => {
      this.syncRoomFor(client);
      return this.safeToStop(client);
    });
    if (candidates.length === 0) return this.advanceTime();
    const client = this.rng.pick(candidates);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    if (this.rng.bool(0.3)) {
      this.send(client, { type: 'STOP_IMMEDIATELY', destinationWpIndex: this.rng.int(player.waypoints.length) }, 'STOP_IMMEDIATELY_INDEX');
    } else {
      this.send(client, { type: 'STOP_IMMEDIATELY' }, 'STOP_IMMEDIATELY');
    }
  }

  private finishPlayer() {
    const candidates = this.runningClients().filter((client) => {
      this.syncRoomFor(client);
      const room = this.rooms.get(client.wsData.roomId!)!;
      return !room.players[client.wsData.playerId!].finishTime;
    });
    if (candidates.length === 0) return this.advanceTime();
    const client = this.rng.pick(candidates);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const elapsed = Math.max(1, room.virtualTime - (room.gameStartTime ?? room.virtualTime));
    this.send(client, { type: 'PLAYER_FINISHED', finishTime: elapsed }, 'PLAYER_FINISHED');
  }

  private raceAgain() {
    const client = this.rng.pick(this.finishedClients());
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    this.send(client, { type: 'RACE_AGAIN', waypoints: clone(player.waypoints) }, 'RACE_AGAIN');
  }

  private addGhosts() {
    const client = this.rng.pick(this.joinedClients());
    const room = this.rooms.get(client.wsData.roomId!)!;
    const start = room.initialStartTime || room.virtualTime;
    const x = room.startPos[1];
    const y = room.startPos[0];
    const ghostName = `ghost-${this.currentStep}-${this.rng.int(1000)}`;
    const waypoints: Waypoint[] = [
      { x, y, startTime: start, arrivalTime: start, speedFactor: 1, stopName: 'ghost-start' },
      { x: x + 0.1, y: y + 0.1, startTime: start, arrivalTime: start + 60_000, speedFactor: 50, stopName: 'ghost-end' },
    ];
    this.send(client, { type: 'ADD_GHOSTS', ghosts: [{ playerName: ghostName, color: '#888888', waypoints }] }, 'ADD_GHOSTS');
  }

  private kickGhost() {
    const candidates = this.joinedClients().filter((client) => {
      const room = this.rooms.get(client.wsData.roomId!);
      return room && Object.values(room.players).some((player) => player.isGhost);
    });
    if (candidates.length === 0) return this.advanceTime();
    const client = this.rng.pick(candidates);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const ghost = this.rng.pick(Object.values(room.players).filter((player) => player.isGhost));
    this.send(client, { type: 'PLAYER_KICK', playerId: ghost.id }, 'PLAYER_KICK_GHOST');
  }

  private advanceTime() {
    const jumps = [1, 10, 25, 50, 100, 250, 1000, 5000, 60_000, 61_000];
    const ms = this.rng.pick(jumps);
    this.record({ action: 'ADVANCE_TIME', message: { ms } });
    this.clock.advance(ms);
  }

  private sendHostileMessage() {
    const client = this.rng.pick(this.connectedClients());
    const room = client.wsData.roomId ? (this.rooms.get(client.wsData.roomId) ?? null) : null;
    const realPlayerId = room ? Object.values(room.players).find((player) => !player.isGhost)?.id : client.playerId;
    const startPos = room?.startPos ?? [55.9533, -3.1883];
    const finishPos = room?.finishPos ?? [43.7101, 7.2660];
    const ghostWaypoints = this.validGhostWaypoints(room);
    const malformed = [
      null,
      {},
      { type: 'JOIN_ROOM', roomId: client.roomId, playerId: '__proto__' },
      { type: 'SET_GAME_BOUNDS', startPos: {}, finishPos: [], league: null },
      { type: 'SET_GAME_BOUNDS', startPos, finishPos, startTime: this.clock.nowMs, difficulty: { nope: true }, computerDriver: false, ghosts: false, league: 'not_a_league' },
      { type: 'TOGGLE_READY' },
      { type: 'SET_VIEWING_STOP', stopName: { definitely: 'not a stop name' } },
      { type: 'UPDATE_PLAYER_COLOR', color: { hue: 120 } },
      { type: 'ADD_WAYPOINTS_BATCH', waypoints: [null] },
      { type: 'ADD_WAYPOINTS_BATCH', waypoints: [{ x: startPos[1], y: startPos[0], arrivalTime: this.clock.nowMs + 60_000, speedFactor: 10, isWalk: { wrong: true }, route_short_name: { also: 'wrong' } }] },
      { type: 'ADD_WAYPOINT', x: Number.POSITIVE_INFINITY, y: {}, speedFactor: 'fast' },
      { type: 'ADD_WAYPOINT', x: startPos[1], y: startPos[0], arrivalTime: this.clock.nowMs + 60_000, speedFactor: 10, isWait: { wrong: true }, emoji: { nope: true } },
      { type: 'PLAYER_FINISHED', finishTime: Number.NaN },
      { type: 'RACE_AGAIN', waypoints: [] },
      { type: 'ADD_GHOSTS', ghosts: [{ playerName: 'bad', waypoints: [] }] },
      { type: 'ADD_GHOSTS', ghosts: [{ playerName: 'bad-colour', color: { hue: 20 }, waypoints: ghostWaypoints }] },
      { type: 'PLAYER_KICK', playerId: realPlayerId },
      { type: 'SEND_PING', lat: Number.POSITIVE_INFINITY, lon: Number.NEGATIVE_INFINITY },
    ];
    this.send(client, this.rng.pick(malformed), 'HOSTILE_MESSAGE');
  }

  private connectedClientsOrConnect() {
    const connected = this.connectedClients();
    if (connected.length > 0) return connected;
    this.connectOrReconnect();
    return this.connectedClients();
  }

  private validGhostWaypoints(room: Room | null): Waypoint[] {
    const start = room?.initialStartTime ?? this.clock.nowMs;
    const startPos = room?.startPos ?? [55.9533, -3.1883];
    return [
      { x: startPos[1], y: startPos[0], startTime: start, arrivalTime: start, speedFactor: 1, stopName: 'ghost-start' },
      { x: startPos[1] + 0.1, y: startPos[0] + 0.1, startTime: start, arrivalTime: start + 60_000, speedFactor: 50, stopName: 'ghost-end' },
    ];
  }

  private syncRoomFor(client: Client) {
    if (client.wsData.roomId) this.updateRoom(client.wsData.roomId);
  }

  private nextWaypointFor(client: Client): Omit<Waypoint, 'startTime'> {
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    const last = player.waypoints[player.waypoints.length - 1];
    const start = Math.max(last.arrivalTime, room.virtualTime);
    return {
      x: last.x + this.deltaCoord(),
      y: last.y + this.deltaCoord(),
      arrivalTime: start + 1000 + this.rng.int(5 * 60 * 1000),
      speedFactor: 1 + this.rng.int(500),
      stopName: `wp-${this.currentStep}`,
      isWalk: this.rng.bool(0.15),
      isWait: this.rng.bool(0.08),
      isInterstop: this.rng.bool(0.2),
      route_short_name: `R${this.rng.int(50)}`,
      timeStr: '12:00',
    };
  }

  private nextWaypointAfter(previous: Omit<Waypoint, 'startTime'>): Omit<Waypoint, 'startTime'> {
    return {
      ...previous,
      x: previous.x + this.deltaCoord(),
      y: previous.y + this.deltaCoord(),
      arrivalTime: previous.arrivalTime + 1000 + this.rng.int(5 * 60 * 1000),
      stopName: `wp-${this.currentStep}-${this.rng.int(1000)}`,
    };
  }

  private safeToStop(client: Client) {
    const room = this.rooms.get(client.wsData.roomId!);
    if (!room) return false;
    const player = room.players[client.wsData.playerId!];
    if (!player || player.waypoints.length < 2) return false;
    const nextIndex = player.waypoints.findIndex((wp) => wp.arrivalTime > room.virtualTime);
    if (nextIndex === -1) return true;
    const next = player.waypoints[nextIndex];
    const prev = player.waypoints[nextIndex - 1] ?? player.waypoints[0];
    const segmentStart = Math.max(prev.arrivalTime, next.startTime);
    return room.virtualTime >= segmentStart && room.virtualTime < next.arrivalTime;
  }

  private coord(min: number, max: number) {
    return min + (max - min) * this.rng.next();
  }

  private deltaCoord() {
    return (this.rng.next() - 0.5) * 0.2;
  }

  private colorFor(client: Client) {
    const hue = Number(client.id.replace('client-', '')) * 70;
    return `hsl(${hue % 360}, 70%, 50%)`;
  }

  private assertInvariants() {
    const seenTimerIds = new Set<number>();
    for (const client of this.clients) {
      if (!client.connected || !client.wsData.roomId || !client.wsData.playerId) continue;
      const room = this.rooms.get(client.wsData.roomId);
      assert(room && Object.prototype.hasOwnProperty.call(room.players, client.wsData.playerId), `${client.id} is connected but missing player ${client.wsData.playerId}`);
    }

    for (const [roomId, room] of this.rooms) {
      assert(room.id === roomId, `room key/id mismatch: ${roomId} !== ${room.id}`);
      assert(room.state === 'JOINING' || room.state === 'COUNTDOWN' || room.state === 'RUNNING', `invalid room state: ${room.state}`);
      assert(finiteNumber(room.virtualTime), `room ${roomId} has invalid virtualTime: ${room.virtualTime}`);
      assert(finiteNumber(room.lastRealTime), `room ${roomId} has invalid lastRealTime: ${room.lastRealTime}`);
      assert(finiteNumber(room.initialStartTime), `room ${roomId} has invalid initialStartTime: ${room.initialStartTime}`);
      assert(finiteNumber(room.playbackRate) && room.playbackRate >= 0, `room ${roomId} has invalid playbackRate: ${room.playbackRate}`);
      assertCoord(room.startPos, `room ${roomId}.startPos`);
      if (room.finishPos !== null) assertCoord(room.finishPos, `room ${roomId}.finishPos`);
      assert(room.difficulty === 'Easy' || room.difficulty === 'Normal' || room.difficulty === 'Transport nerd', `room ${roomId} has invalid difficulty: ${String(room.difficulty)}`);
      assert(typeof room.league === 'string' && /^\d{8}$/.test(room.league), `room ${roomId} has invalid league: ${String(room.league)}`);

      if (room.state === 'JOINING') {
        assert(room.countdownEnd === null, `room ${roomId} is JOINING with countdownEnd ${room.countdownEnd}`);
        assert(room.gameStartTime === null, `room ${roomId} is JOINING with gameStartTime ${room.gameStartTime}`);
      }
      if (room.state === 'COUNTDOWN') {
        assert(finiteNumber(room.countdownEnd), `room ${roomId} is COUNTDOWN without finite countdownEnd`);
        const realPlayers = Object.values(room.players).filter((player) => !player.isGhost);
        assert(realPlayers.length > 0, `room ${roomId} is COUNTDOWN with no real players`);
        assert(realPlayers.every((player) => player.isReady), `room ${roomId} is COUNTDOWN but not all real players are ready`);
      }
      if (room.state === 'RUNNING') {
        assert(room.countdownEnd === null, `room ${roomId} is RUNNING with countdownEnd ${room.countdownEnd}`);
        assert(finiteNumber(room.gameStartTime), `room ${roomId} is RUNNING without finite gameStartTime`);
        const expectedRate = this.expectedPlaybackRate(room);
        assert(Math.abs(room.playbackRate - expectedRate) <= 0.01, `room ${roomId} playbackRate ${room.playbackRate} !== expected ${expectedRate}`);
      }

      if (room.timerId !== undefined) {
        assert(typeof room.timerId === 'number', `room ${roomId} has non-numeric timer id`);
        assert(!seenTimerIds.has(room.timerId), `timer ${room.timerId} is attached to multiple rooms`);
        seenTimerIds.add(room.timerId);
        assert(this.clock.hasTimer(room.timerId), `room ${roomId} points at missing timer ${room.timerId}`);
      }

      this.assertPlayers(room);
    }

    assert(this.clock.activeTimerCount() <= this.rooms.size, `too many active timers: ${this.clock.activeTimerCount()} for ${this.rooms.size} rooms`);
  }

  private assertPlayers(room: Room) {
    for (const [playerId, player] of Object.entries(room.players)) {
      assert(player.id === playerId, `player key/id mismatch in ${room.id}: ${playerId} !== ${player.id}`);
      assert(typeof player.color === 'string', `player ${playerId} has invalid color`);
      assert(typeof player.isReady === 'boolean', `player ${playerId} has invalid ready flag`);
      assert(Array.isArray(player.waypoints) && player.waypoints.length > 0, `player ${playerId} has no waypoints`);
      assert(finiteNumber(player.desiredRate), `player ${playerId} has invalid desiredRate: ${player.desiredRate}`);
      assert(typeof player.forceRealtime === 'boolean', `player ${playerId} has invalid forceRealtime`);
      assert(player.finishTime === null || finiteNumber(player.finishTime), `player ${playerId} has invalid finishTime: ${player.finishTime}`);
      assert(player.disconnectedAt === null || finiteNumber(player.disconnectedAt), `player ${playerId} has invalid disconnectedAt: ${player.disconnectedAt}`);
      assert(player.viewingStopName === null || typeof player.viewingStopName === 'string', `player ${playerId} has invalid viewingStopName`);
      assert(typeof player.isGhost === 'boolean', `player ${playerId} has invalid isGhost`);
      if (room.state === 'RUNNING' && !player.isGhost) {
        assert(player.isReady, `running player ${playerId} is not ready`);
        assert(player.waypoints[0].arrivalTime >= (room.gameStartTime ?? -Infinity), `running player ${playerId} starts before game start`);
      }

      let previousArrival = Number.NEGATIVE_INFINITY;
      player.waypoints.forEach((waypoint, index) => {
        assertWaypoint(waypoint, `player ${playerId} waypoint ${index}`);
        assert(waypoint.startTime >= previousArrival, `player ${playerId} waypoint ${index} starts before previous arrival`);
        assert(waypoint.arrivalTime >= waypoint.startTime, `player ${playerId} waypoint ${index} arrives before it starts`);
        previousArrival = waypoint.arrivalTime;
      });
    }
  }

  private expectedPlaybackRate(room: Room) {
    if (this.subscriberCount(room.id) === 0) return 0;
    const activeFactors: number[] = [];
    for (const player of Object.values(room.players)) {
      if (player.isGhost || player.finishTime !== null) continue;
      let currentFactor = player.forceRealtime ? 1.0 : (player.desiredRate || 1.0);
      for (const waypoint of player.waypoints) {
        if (room.virtualTime >= waypoint.startTime && room.virtualTime < waypoint.arrivalTime) {
          currentFactor = player.forceRealtime ? 1.0 : Math.max(waypoint.speedFactor, player.desiredRate || 1.0);
          break;
        }
      }
      activeFactors.push(currentFactor);
    }
    return activeFactors.length > 0 ? Math.max(1.0, Math.min(...activeFactors)) : 1.0;
  }
}

function assertCoord(value: unknown, label: string): asserts value is [number, number] {
  assert(Array.isArray(value) && value.length === 2, `${label} is not a coordinate pair`);
  assert(finiteNumber(value[0]) && finiteNumber(value[1]), `${label} has non-finite coordinates: ${formatJson(value)}`);
  assert(value[0] >= -90 && value[0] <= 90, `${label} latitude is out of range: ${value[0]}`);
  assert(value[1] >= -180 && value[1] <= 180, `${label} longitude is out of range: ${value[1]}`);
}

function assertWaypoint(waypoint: Waypoint, label: string) {
  assert(waypoint && typeof waypoint === 'object', `${label} is not an object`);
  assert(finiteNumber(waypoint.x) && waypoint.x >= -180 && waypoint.x <= 180, `${label} has invalid x: ${String(waypoint.x)}`);
  assert(finiteNumber(waypoint.y) && waypoint.y >= -90 && waypoint.y <= 90, `${label} has invalid y: ${String(waypoint.y)}`);
  assert(finiteNumber(waypoint.startTime), `${label} has invalid startTime: ${String(waypoint.startTime)}`);
  assert(finiteNumber(waypoint.arrivalTime), `${label} has invalid arrivalTime: ${String(waypoint.arrivalTime)}`);
  assert(finiteNumber(waypoint.speedFactor) && waypoint.speedFactor >= 0, `${label} has invalid speedFactor: ${String(waypoint.speedFactor)}`);
  assert(waypoint.stopName === undefined || typeof waypoint.stopName === 'string', `${label} has invalid stopName`);
  assert(waypoint.isWalk === undefined || typeof waypoint.isWalk === 'boolean', `${label} has invalid isWalk`);
  assert(waypoint.isWait === undefined || typeof waypoint.isWait === 'boolean', `${label} has invalid isWait`);
  assert(waypoint.isInterstop === undefined || typeof waypoint.isInterstop === 'boolean', `${label} has invalid isInterstop`);
  assert(waypoint.route_color === undefined || typeof waypoint.route_color === 'string', `${label} has invalid route_color`);
  assert(waypoint.route_short_name === undefined || typeof waypoint.route_short_name === 'string', `${label} has invalid route_short_name`);
  assert(waypoint.display_name === undefined || typeof waypoint.display_name === 'string', `${label} has invalid display_name`);
  assert(waypoint.emoji === undefined || typeof waypoint.emoji === 'string', `${label} has invalid emoji`);
  assert(waypoint.route_departure_time === undefined || typeof waypoint.route_departure_time === 'string', `${label} has invalid route_departure_time`);
  assert(waypoint.timeStr === undefined || typeof waypoint.timeStr === 'string', `${label} has invalid timeStr`);
}

function installDeterminism(clock: FakeClock, rng: Rng) {
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;

  Date.now = () => clock.nowMs;
  globalThis.setTimeout = ((fn: () => void, delay?: number) => clock.setTimeout(fn, Number(delay ?? 0))) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => clock.clearTimeout(Number(id))) as typeof clearTimeout;
  Math.random = () => rng.next();

  return () => {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Math.random = originalRandom;
  };
}

function main() {
  const options = parseOptions(process.argv);
  const rng = new Rng(options.seed);
  const clock = new FakeClock();
  const restore = installDeterminism(clock, rng);

  try {
    const fuzzer = new MultiplayerFuzzer(options, rng, clock);
    fuzzer.run();
    console.log(`multiplayer fuzz passed: seed=${options.seed} steps=${options.steps} clients=${options.clients} rooms=${options.rooms} hostile=${options.hostile}`);
  } catch (err) {
    if (err instanceof FuzzFailure) {
      console.error(`multiplayer fuzz failed: seed=${options.seed} steps=${options.steps} clients=${options.clients} rooms=${options.rooms} hostile=${options.hostile}`);
      console.error(err.message);
      console.error('recent trace:');
      for (const entry of err.trace) console.error(formatJson(entry));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    restore();
  }
}

main();
