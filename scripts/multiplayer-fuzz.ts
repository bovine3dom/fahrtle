import {
  boundsToWire,
  getProjectedRoomClock,
  getProjectedRoomTime,
  getRoomBounds,
  handleGameClose,
  handleIncomingMessage,
  updateRoomLogic,
  type Difficulty,
  type GameHooks,
  type Room,
  type Waypoint,
} from '../src/shared/gameLogic';
import { createClockState, projectClock } from '../src/time-sync';
import { bindCurrentWebSocket, parseWebSocketMessage } from '../src/websocket';
import { buildRenderablePlayer, buildRenderablePlayers, getPlayerMotionAt } from '../src/playerRendering';

type WsData = { roomId: string | null; playerId: string | null };

type Client = {
  id: string;
  playerId: string;
  roomId: string;
  connected: boolean;
  wsData: WsData;
  inbox: unknown[];
  checkedInboxLength: number;
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

  timerAt(id: unknown) {
    return typeof id === 'number' ? this.timers.get(id)?.at : undefined;
  }

  activeTimerCount() {
    return this.timers.size;
  }

  shiftWallTime(ms: number) {
    if (!Number.isFinite(ms)) throw new Error(`Invalid wall clock shift: ${ms}`);
    this.nowMs += ms;
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
      checkedInboxLength: 0,
    }));
  }

  run() {
    try {
      this.assertClockSynchronizationUnderNetworkFaults();
      this.assertStaleSocketEventsIgnored();
      this.assertRenderableSnapshots();
      this.assertRateBoundariesAreIntegrated();
      this.assertProjectionDoesNotRescanRoutes();
      this.assertBoundaryInputs();
      this.assertJoiningResetConverges();
      this.assertDisconnectedPlayersDoNotPinPlayback();
      this.assertStopClearsViewingState();
      this.assertGhostFinishesExactlyOnce();
      this.assertExtremeNumbersAreRejected();
      this.assertRaceAgainRequiresConnectedFinishers();
      this.assertBroadcastClockProjection();
      this.assertServerClockRollbackDoesNotRewind();
      this.assertInvariants();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FuzzFailure(`Setup: ${message}`, this.recentTrace());
    }

    for (this.currentStep = 0; this.currentStep < this.options.steps; this.currentStep++) {
      try {
        this.runAction();
        this.assertInvariants();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new FuzzFailure(`Step ${this.currentStep}: ${message}`, this.recentTrace());
      }
    }
    try {
      this.cleanupAndAssert();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FuzzFailure(`Cleanup: ${message}`, this.recentTrace());
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
      () => this.jumpServerClockBackward(),
    ];

    if (this.joinedClients().length > 0) {
      actions.push(
        () => this.setGameBounds(),
        () => this.toggleReady(),
        () => this.toggleSnooze(),
        () => this.forceRealtime(),
        () => this.setViewingStop(),
        () => this.updateColor(),
        () => this.sendPing(),
        () => this.switchRoom(),
        () => this.duplicateSession(),
        () => this.disconnect(),
        () => this.closeStaleConnection(),
        () => this.addGhosts(),
        () => this.kickGhost(),
      );
    }

    if (this.routingClients().length > 0) {
      actions.push(
        () => this.addWaypoint(),
        () => this.addWalkingWaypoint(),
        () => this.addWaypointsBatch(),
        () => this.addPlannedService(),
        () => this.addStaleTeleport(),
        () => this.addRailStyleEarlyBatch(),
        () => this.advanceToNextWaypointEvent(),
        () => this.stopImmediately(),
        () => this.finishPlayer(),
      );
    }

    if (this.finishedClients().length > 0) {
      actions.push(() => this.raceAgain());
    }

    if (this.reusableRoomClients().length > 0) {
      actions.push(() => this.reuseFinishedRoom());
    }

    if (this.options.hostile && this.connectedClients().length > 0) {
      actions.push(
        () => this.sendHostileMessage(),
        () => this.sendMalformedFrame(),
      );
    }

    return actions;
  }

  private hooksFor(client?: Client): GameHooks {
    return {
      broadcastRoomState: (room) => {
        const bounds = getRoomBounds(room);
        const projectedClock = getProjectedRoomClock(room);
        this.publish(room.id, {
          type: 'ROOM_STATE_UPDATE',
          state: room.state,
          countdownEnd: room.countdownEnd,
          gameStartTime: room.gameStartTime,
          ...boundsToWire(bounds),
          serverTime: projectedClock.virtualTime,
          realTime: Date.now(),
          isRerun: room.isRerun,
          rate: projectedClock.playbackRate,
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
      unsubscribeFromRoom: (roomId) => {
        if (!client?.connected) return;
        this.subscriptions.get(roomId)?.delete(client.id);
      },
      shouldDeletePlayer: (roomId, playerId) => !this.clients.some((c) => c.connected && c.wsData.roomId === roomId && c.wsData.playerId === playerId),
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
    const wireMessage = JSON.stringify(message);
    if (wireMessage === undefined) return;
    const parsed = parseWebSocketMessage(wireMessage);
    if (parsed !== undefined) handleIncomingMessage(parsed, this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
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
      return player && player.finishTime === null;
    });
  }

  private finishedClients() {
    return this.runningClients().filter((client) => {
      const room = this.rooms.get(client.wsData.roomId!);
      const player = room?.players[client.wsData.playerId!];
      return player?.finishTime !== null && player?.finishTime !== undefined && player.waypoints.length > 1;
    });
  }

  private connectOrReconnect() {
    const candidates = this.clients.filter((client) => !client.connected || !client.wsData.roomId);
    const client = candidates.length > 0 ? this.rng.pick(candidates) : this.rng.pick(this.clients);

    if (client.connected && client.wsData.roomId) return this.sendSyncRequest();

    client.connected = true;
    client.wsData = { roomId: null, playerId: null };
    client.inbox = [];
    client.checkedInboxLength = 0;
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
    const stopName = this.rng.bool(0.2) ? null : `stop-${this.rng.int(100)}`;
    this.send(this.rng.pick(this.joinedClients()), { type: 'SET_VIEWING_STOP', stopName }, 'SET_VIEWING_STOP');
  }

  private updateColor() {
    this.send(this.rng.pick(this.joinedClients()), { type: 'UPDATE_PLAYER_COLOR', color: `hsl(${this.rng.int(360)}, 70%, 50%)` }, 'UPDATE_PLAYER_COLOR');
  }

  private sendPing() {
    const client = this.rng.pick(this.joinedClients());
    const lat = this.coord(-85, 85);
    const lon = this.coord(-180, 180);
    const recipients = this.connectedClients().filter((candidate) => candidate.wsData.roomId === client.wsData.roomId);
    this.send(client, { type: 'SEND_PING', lat, lon }, 'SEND_PING');
    for (const recipient of recipients) {
      assert(recipient.inbox.some((message) => isMessage(message, 'RECV_PING')
        && message.playerId === client.wsData.playerId
        && message.lat === lat
        && message.lon === lon
        && message.timestamp === this.clock.nowMs), `ping from ${client.id} was not delivered to ${recipient.id}`);
    }
  }

  private switchRoom() {
    if (this.options.rooms < 2) return this.sendSyncRequest();
    const client = this.rng.pick(this.joinedClients());
    const currentIndex = Number(client.wsData.roomId?.replace('room-', '') ?? 0);
    const nextIndex = (currentIndex + 1 + this.rng.int(this.options.rooms - 1)) % this.options.rooms;
    this.send(client, {
      type: 'JOIN_ROOM',
      roomId: `room-${nextIndex}`,
      playerId: client.playerId,
      color: this.colorFor(client),
    }, 'SWITCH_ROOM');
  }

  private duplicateSession() {
    const target = this.rng.pick(this.joinedClients());
    const candidates = this.clients.filter((client) => client.id !== target.id
      && (!client.connected || client.wsData.roomId !== target.wsData.roomId || client.wsData.playerId !== target.wsData.playerId));
    if (candidates.length === 0) return this.sendSyncRequest();
    const client = this.rng.pick(candidates);
    if (!client.connected) {
      client.connected = true;
      client.wsData = { roomId: null, playerId: null };
      client.inbox = [];
      client.checkedInboxLength = 0;
    }
    this.send(client, {
      type: 'JOIN_ROOM',
      roomId: target.wsData.roomId,
      playerId: target.wsData.playerId,
      color: this.colorFor(client),
    }, 'DUPLICATE_SESSION');
  }

  private assertDisconnectedPlayersDoNotPinPlayback() {
    if (this.clients.length < 2) return;

    const first = this.clients[0];
    first.connected = true;
    first.wsData = { roomId: null, playerId: null };
    first.inbox = [];
    first.checkedInboxLength = 0;
    this.send(first, { type: 'JOIN_ROOM', roomId: 'room-0', playerId: first.playerId, color: this.colorFor(first) }, 'PIN_REGRESSION_JOIN_FIRST');
    this.send(first, {
      type: 'SET_GAME_BOUNDS',
      startPos: [55.9533, -3.1883],
      finishPos: [43.7101, 7.2660],
      startTime: this.clock.nowMs,
      difficulty: 'Easy',
      computerDriver: false,
      ghosts: false,
      league: '20260706',
    }, 'PIN_REGRESSION_SET_BOUNDS');
    this.send(first, { type: 'TOGGLE_READY' }, 'PIN_REGRESSION_READY_FIRST');
    this.clock.advance(6_000);

    const room = this.rooms.get('room-0');
    assert(room?.state === 'RUNNING', 'pin regression room did not start');

    this.record({ action: 'PIN_REGRESSION_DISCONNECT_FIRST', client: first.id });
    first.connected = false;
    for (const subscribers of this.subscriptions.values()) subscribers.delete(first.id);
    handleGameClose(this.rooms, first.wsData, this.hooksFor(first), this.updateRoom);

    const second = this.clients[1];
    second.connected = true;
    second.wsData = { roomId: null, playerId: null };
    second.inbox = [];
    second.checkedInboxLength = 0;
    this.send(second, { type: 'JOIN_ROOM', roomId: 'room-0', playerId: second.playerId, color: this.colorFor(second) }, 'PIN_REGRESSION_JOIN_SECOND');

    const updatedRoom = this.rooms.get('room-0')!;
    const player = updatedRoom.players[second.playerId];
    const last = player.waypoints[player.waypoints.length - 1];
    this.send(second, {
      type: 'ADD_WAYPOINTS_BATCH',
      waypoints: [{
        x: this.safeX(last.x + this.deltaCoord()),
        y: this.safeY(last.y + this.deltaCoord()),
        arrivalTime: updatedRoom.virtualTime + 60_000,
        speedFactor: 20,
        stopName: 'pin regression fast segment',
      }],
    }, 'PIN_REGRESSION_FAST_SEGMENT');

    assert(updatedRoom.players[first.playerId].disconnectedAt !== null, 'pin regression player was not disconnected');
    assert(updatedRoom.playbackRate > 1, `disconnected player pinned playback at ${updatedRoom.playbackRate}`);
  }

  private assertBoundaryInputs() {
    const client = this.clients[0];
    client.connected = true;
    client.wsData = { roomId: null, playerId: null };
    client.inbox = [];
    client.checkedInboxLength = 0;
    this.send(client, { type: 'JOIN_ROOM', roomId: 'room-0', playerId: 'toString', color: { invalid: true } }, 'BOUNDARY_JOIN_PROTOTYPE_ID');
    const room = this.rooms.get('room-0');
    assert(room && Object.prototype.hasOwnProperty.call(room.players, 'toString'), 'prototype-named player was not created as an own property');
    const prototypePlayer = room.players['toString'];
    assert(typeof prototypePlayer.color === 'string', 'invalid join color poisoned player state');
    this.send(client, {
      type: 'SET_GAME_BOUNDS', startPos: [90, 180], finishPos: [-90, -180],
      startTime: this.clock.nowMs, difficulty: 'Easy', computerDriver: false,
      ghosts: false, league: '20260706',
    }, 'BOUNDARY_POLAR_BOUNDS');
    assertWaypoint(prototypePlayer.waypoints[0], 'polar spawn waypoint');
    this.send(client, { type: 'JOIN_ROOM', roomId: 'room-0', playerId: client.playerId, color: this.colorFor(client) }, 'BOUNDARY_RESTORE_PLAYER');
    const previousData = { ...client.wsData };
    this.send(client, { type: 'JOIN_ROOM', roomId: 'room-0\0collision', playerId: client.playerId }, 'BOUNDARY_NUL_ROOM');
    assert(client.wsData.roomId === previousData.roomId && client.wsData.playerId === previousData.playerId, 'NUL-containing identity changed the connection');
  }

  private assertRenderableSnapshots() {
    for (let iteration = 0; iteration < 200; iteration++) {
      const localStart = this.clock.nowMs + this.rng.int(1_000_000);
      const makePlayer = (id: string, startOffset: number) => {
        const start = localStart + startOffset;
        const firstArrival = start + this.rng.int(10_000);
        const secondStart = firstArrival + 1 + this.rng.int(60_000);
        const secondArrival = secondStart + 1 + this.rng.int(60_000);
        return {
          id,
          isGhost: id !== 'local',
          waypoints: [
            { x: 1, y: 2, startTime: start, arrivalTime: firstArrival, speedFactor: 1 },
            { x: 3, y: 4, startTime: secondStart, arrivalTime: secondArrival, speedFactor: 20 },
          ],
        };
      };
      const local = makePlayer('local', 0);
      const remote = makePlayer('remote', this.rng.int(120_000) - 60_000);
      const players = this.rng.bool()
        ? { local, remote }
        : { remote, local };
      const renderables = buildRenderablePlayers(players, localStart);
      for (const [id, raw] of Object.entries(players)) {
        const segment = renderables[id].segments[0];
        const offset = local.waypoints[0].startTime - raw.waypoints[0].startTime;
        assert(finiteNumber(segment.startTime) && finiteNumber(segment.endTime), `${id} snapshot produced non-finite segment times`);
        assert(segment.startTime === raw.waypoints[1].startTime + offset, `${id} snapshot erased a timetable gap`);
        assert(segment.endTime === raw.waypoints[1].arrivalTime + offset, `${id} snapshot changed segment arrival`);
      }
      const missingLocal = buildRenderablePlayer(remote);
      assert(missingLocal.segments.every((segment) => finiteNumber(segment.startTime) && finiteNumber(segment.endTime)), 'missing local player produced non-finite segments');
      const renderedLocal = renderables.local;
      const gapTime = renderedLocal.waypoints[0].arrivalTime + 0.5;
      assert(formatJson(getPlayerMotionAt(renderedLocal, gapTime)?.position) === '[1,2]', 'player moved during a timetable gap');
      const activeTime = (renderedLocal.segments[0].startTime + renderedLocal.segments[0].endTime) / 2;
      const activePosition = getPlayerMotionAt(renderedLocal, activeTime)?.position;
      assert(activePosition?.[0] === 2 && activePosition[1] === 3, 'active segment interpolation was incorrect');
      assert(formatJson(getPlayerMotionAt(renderedLocal, renderedLocal.segments[0].endTime)?.position) === '[3,4]', 'completed route did not end at its destination');
    }
  }

  private assertRateBoundariesAreIntegrated() {
    const player = this.testPlayer('rate-player', [
      { x: 0, y: 0, startTime: 0, arrivalTime: 0, speedFactor: 1 },
      { x: 1, y: 1, startTime: 0, arrivalTime: 1_000, speedFactor: 500 },
      { x: 2, y: 2, startTime: 1_000, arrivalTime: 2_000, speedFactor: 1 },
    ]);
    const room = this.testRoom('rate-boundary', { [player.id]: player });
    room.virtualTime = 0;
    room.lastRealTime = 0;
    room.playbackRate = 500;
    const projectedClock = getProjectedRoomClock(room, 50);
    assert(projectedClock.virtualTime === 1_048, `late timer skipped a rate boundary: ${projectedClock.virtualTime}`);
    assert(projectedClock.playbackRate === 1, 'projected clock retained its pre-boundary rate');
  }

  private assertProjectionDoesNotRescanRoutes() {
    const waypointCount = 400;
    let waypointReads = 0;
    const rawWaypoints = Array.from({ length: waypointCount }, (_unused, index) => ({
      x: 0, y: 0, startTime: index * 2, arrivalTime: index * 2 + 1, speedFactor: 1_000_000,
    }));
    const waypoints = new Proxy(rawWaypoints, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) waypointReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const player = this.testPlayer('projection-scale', waypoints);
    player.desiredRate = 500;
    const room = this.testRoom('projection-scale', { [player.id]: player });
    room.playbackRate = 500;
    getProjectedRoomClock(room, 100);
    assert(waypointReads < waypointCount * 20, `projection rescanned ${waypointCount} waypoints ${waypointReads} times`);
  }

  private assertJoiningResetConverges() {
    const client = this.clients[0];
    const room = this.rooms.get(client.wsData.roomId!)!;
    const ghostId = '👻-bounds-reset';
    const start = room.virtualTime;
    this.send(client, {
      type: 'ADD_GHOSTS',
      ghosts: [{ playerName: 'bounds-reset', color: '#888', waypoints: [{ x: 0, y: 0, startTime: start, arrivalTime: start, speedFactor: 1 }] }],
    }, 'RESET_REGRESSION_ADD_GHOST');
    this.send(client, { type: 'SET_VIEWING_STOP', stopName: 'stale stop' }, 'RESET_REGRESSION_VIEW_STOP');
    const inboxStart = client.inbox.length;
    this.send(client, {
      type: 'SET_GAME_BOUNDS', startPos: [0, 0], finishPos: [1, 1], startTime: 0,
      difficulty: 'Easy', computerDriver: false, ghosts: false, league: '20260706',
    }, 'RESET_REGRESSION_SET_BOUNDS');
    assert(room.virtualTime === 0 && room.initialStartTime === 0, 'explicit zero start time was ignored');
    assert(!Object.prototype.hasOwnProperty.call(room.players, ghostId), 'bounds reset retained a ghost');
    assert(room.players[client.playerId].viewingStopName === null, 'bounds reset retained authoritative viewing state');
    assert(client.inbox.slice(inboxStart).some((message) => isMessage(message, 'PLAYER_LEFT') && message.playerId === ghostId), 'bounds reset did not publish ghost removal');
    this.send(client, {
      type: 'ADD_GHOSTS',
      ghosts: [{ playerName: 'finish-reset', color: '#888', waypoints: [{ x: 0, y: 0, startTime: 0, arrivalTime: 0, speedFactor: 1 }] }],
    }, 'RESET_REGRESSION_ADD_FINISH_GHOST');
    const finishGhostId = '👻-finish-reset';
    const finishInboxStart = client.inbox.length;
    this.send(client, {
      type: 'SET_GAME_BOUNDS', startPos: [0, 0], finishPos: [2, 2],
      difficulty: 'Easy', computerDriver: false, ghosts: true, league: '20260706',
    }, 'RESET_REGRESSION_FINISH_ONLY');
    assert(!Object.prototype.hasOwnProperty.call(room.players, finishGhostId), 'finish-only bounds change retained a ghost');
    assert(client.inbox.slice(finishInboxStart).some((message) => isMessage(message, 'PLAYER_LEFT') && message.playerId === finishGhostId), 'finish-only bounds change did not publish ghost removal');
    const before = formatJson(getRoomBounds(room));
    this.send(client, {
      type: 'SET_GAME_BOUNDS', startPos: [5, 5], finishPos: [6, 6], startTime: Number.MAX_VALUE,
      difficulty: 'Easy', computerDriver: false, ghosts: false, league: '20260706',
    }, 'RESET_REGRESSION_EXTREME_TIME');
    assert(formatJson(getRoomBounds(room)) === before && room.virtualTime === 0, 'unsafe start time partially changed room bounds');
  }

  private assertClockSynchronizationUnderNetworkFaults() {
    const rates = [0, 1, 20, 500];
    for (let i = 0; i < 500; i++) {
      const rate = this.rng.pick(rates);
      const outbound = this.networkDelay();
      const inbound = this.networkDelay();
      const driftPpm = this.coord(-500, 500);
      const serverAtResponse = this.clock.nowMs + outbound * rate;
      const clientAtReceipt = 1_000_000 + (outbound + inbound) * (1 + driftPpm / 1_000_000);
      const measuredLatency = (outbound + inbound) * (1 + driftPpm / 1_000_000) / 2;
      const state = createClockState(serverAtResponse, rate, measuredLatency, clientAtReceipt);
      const expectedAtReceipt = serverAtResponse + inbound * rate;
      const syncError = Math.abs(measuredLatency - inbound) * rate;
      assert(Math.abs(projectClock(state, clientAtReceipt) - expectedAtReceipt) <= syncError + 0.01,
        `clock did not scale latency at ${rate}x`);

      const dropout = this.rng.bool(0.15) ? this.rng.int(6 * 60 * 60 * 1000) : this.rng.int(60_000);
      const clientAfterDropout = clientAtReceipt + dropout * (1 + driftPpm / 1_000_000);
      const expectedAfterDropout = expectedAtReceipt + dropout * rate;
      const driftError = Math.abs(dropout * driftPpm / 1_000_000 * rate);
      assert(Math.abs(projectClock(state, clientAfterDropout) - expectedAfterDropout) <= syncError + driftError + 0.01,
        `clock exceeded drift bound after ${dropout}ms dropout at ${rate}x`);
    }
  }

  private networkDelay() {
    if (this.rng.bool(0.05)) return this.rng.int(30_000);
    if (this.rng.bool(0.2)) return this.rng.int(2_000);
    return this.rng.int(250);
  }

  private assertStaleSocketEventsIgnored() {
    type TestSocket = {
      id: number;
      onopen: ((event: any) => void) | null;
      onmessage: ((event: any) => void) | null;
      onclose: ((event: any) => void) | null;
    };
    type Event = { socket: TestSocket; type: 'open' | 'message' | 'close'; value?: number };
    let current: TestSocket | null = null;
    let nextSocketId = 1;
    let state = { connected: false, generation: 0, lastMessage: -1 };
    const events: Event[] = [];

    const connect = () => {
      if (current) events.push({ socket: current, type: 'close' });
      const socket: TestSocket = { id: nextSocketId++, onopen: null, onmessage: null, onclose: null };
      current = socket;
      bindCurrentWebSocket(socket, (candidate) => current === candidate, {
        open: () => { state = { ...state, connected: true, generation: socket.id }; },
        message: (event) => { state = { ...state, lastMessage: event.data }; },
        close: () => {
          current = null;
          state = { ...state, connected: false, generation: 0 };
        },
      });
      events.push({ socket, type: 'open' });
    };

    connect();
    for (let i = 0; i < 500; i++) {
      if (!current || this.rng.bool(0.18)) connect();
      if (current && this.rng.bool(0.7)) events.push({ socket: current, type: 'message', value: i });
      if (events.length === 0) continue;
      if (this.rng.bool(0.12)) {
        const droppedSocket = this.rng.pick(events).socket;
        for (let index = events.length - 1; index >= 0; index--) {
          if (events[index].socket === droppedSocket) events.splice(index, 1);
        }
        continue;
      }
      const deliverable = events.filter((event, index) => events.findIndex((candidate) => candidate.socket === event.socket) === index);
      const event = this.rng.pick(deliverable);
      events.splice(events.indexOf(event), 1);
      const wasCurrent = event.socket === current;
      const before = { ...state };
      if (event.type === 'open') event.socket.onopen?.({});
      else if (event.type === 'message') event.socket.onmessage?.({ data: event.value });
      else event.socket.onclose?.({});
      if (!wasCurrent) assert(formatJson(state) === formatJson(before), `stale socket ${event.type} mutated current connection state`);
    }
  }

  private assertBroadcastClockProjection() {
    const client = this.joinedClients().find((candidate) => this.rooms.get(candidate.wsData.roomId!)?.state === 'RUNNING');
    if (!client) return;
    const room = this.rooms.get(client.wsData.roomId!)!;
    this.clock.advance(25);
    this.hooksFor(client).broadcastRoomState(room);
    const message = [...client.inbox].reverse().find((value) => isMessage(value, 'ROOM_STATE_UPDATE'));
    assert(message && message.serverTime === getProjectedRoomTime(room, message.realTime), 'room update published a stale virtual-time anchor');
  }

  private assertServerClockRollbackDoesNotRewind() {
    const room = Array.from(this.rooms.values()).find((candidate) => candidate.state === 'RUNNING');
    if (!room) return;
    this.updateRoom(room.id);
    const before = room.virtualTime;
    this.clock.shiftWallTime(-30_000);
    this.updateRoom(room.id);
    assert(room.virtualTime >= before, 'server wall-clock rollback rewound virtual time');
    this.clock.shiftWallTime(30_000);
    this.updateRoom(room.id);
  }

  private assertStopClearsViewingState() {
    const client = this.joinedClients().find((candidate) => this.rooms.get(candidate.wsData.roomId!)?.state === 'RUNNING');
    if (!client) return;
    this.send(client, { type: 'SET_VIEWING_STOP', stopName: 'running stale stop' }, 'STOP_VIEW_REGRESSION_SET');
    this.send(client, { type: 'STOP_IMMEDIATELY' }, 'STOP_VIEW_REGRESSION_STOP');
    const room = this.rooms.get(client.wsData.roomId!)!;
    assert(room.players[client.wsData.playerId!].viewingStopName === null, 'stop immediately retained authoritative viewing state');
  }

  private assertGhostFinishesExactlyOnce() {
    const client = this.joinedClients().find((candidate) => this.rooms.get(candidate.wsData.roomId!)?.state === 'RUNNING');
    if (!client) return;
    const room = this.rooms.get(client.wsData.roomId!)!;
    const playerStart = room.players[client.wsData.playerId!].waypoints[0].startTime;
    const ghostId = '👻-zero-finish';
    const inboxStart = client.inbox.length;
    this.send(client, {
      type: 'ADD_GHOSTS',
      ghosts: [{ playerName: 'zero-finish', color: '#888', waypoints: [{ x: 0, y: 0, startTime: playerStart, arrivalTime: playerStart, speedFactor: 1 }] }],
    }, 'ZERO_GHOST_ADD');
    assert(room.players[ghostId].finishTime === 0, 'late zero-duration ghost was not finished immediately');
    this.updateRoom(room.id);
    assert(room.players[ghostId].finishTime === 0, 'zero-duration ghost did not finish at zero');
    const updates = client.inbox.slice(inboxStart).filter((message) => isMessage(message, 'PLAYER_FINISH_UPDATE') && message.playerId === ghostId);
    assert(updates.length === 1, `zero-duration ghost emitted ${updates.length} finish updates`);
  }

  private assertExtremeNumbersAreRejected() {
    const client = this.routingClients()[0];
    if (!client) return;
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    const waypointCount = player.waypoints.length;
    this.send(client, {
      type: 'ADD_WAYPOINT', x: 0, y: 0, arrivalTime: room.virtualTime + 1_000,
      speedFactor: Number.MAX_VALUE,
    }, 'EXTREME_SPEED_FACTOR');
    assert(player.waypoints.length === waypointCount, 'extreme speed factor changed the route');
    this.send(client, { type: 'PLAYER_FINISHED', finishTime: Number.MAX_VALUE }, 'EXTREME_FINISH_TIME');
    assert(player.finishTime === null, 'extreme finish time finished the player');
  }

  private testPlayer(id: string, waypoints: Waypoint[]) {
    return {
      id, color: '#888', isReady: true, waypoints, desiredRate: 1,
      forceRealtime: false, finishTime: null, disconnectedAt: null,
      viewingStopName: null, isGhost: false,
    };
  }

  private testRoom(id: string, players: Room['players']): Room {
    return {
      id, players, state: 'RUNNING', countdownEnd: null, emptySince: null,
      gameStartTime: 0, startPos: [0, 0], finishPos: [1, 1], virtualTime: 0,
      lastRealTime: 0, playbackRate: 1, initialStartTime: 0,
      difficulty: 'Easy', isRerun: false, league: '20260706',
    };
  }

  private assertRaceAgainRequiresConnectedFinishers() {
    if (this.clients.length < 5 || this.options.rooms < 2) return;

    const roomId = 'room-1';
    const first = this.clients[2];
    const second = this.clients[3];
    const third = this.clients[4];
    for (const client of [first, second, third]) {
      client.connected = true;
      client.wsData = { roomId: null, playerId: null };
      client.inbox = [];
      client.checkedInboxLength = 0;
      this.send(client, { type: 'JOIN_ROOM', roomId, playerId: client.playerId, color: this.colorFor(client) }, 'RACE_AGAIN_GUARD_JOIN');
    }
    this.send(first, {
      type: 'SET_GAME_BOUNDS',
      startPos: [55.9533, -3.1883],
      finishPos: [43.7101, 7.2660],
      startTime: this.clock.nowMs,
      difficulty: 'Easy',
      computerDriver: false,
      ghosts: false,
      league: '20260706',
    }, 'RACE_AGAIN_GUARD_SET_BOUNDS');
    this.send(first, { type: 'TOGGLE_READY' }, 'RACE_AGAIN_GUARD_READY');
    this.send(second, { type: 'TOGGLE_READY' }, 'RACE_AGAIN_GUARD_READY');
    this.send(third, { type: 'TOGGLE_READY' }, 'RACE_AGAIN_GUARD_READY');
    this.clock.advance(6_000);

    const room = this.rooms.get(roomId);
    assert(room?.state === 'RUNNING', 'race again guard room did not start');
    const existingGhostId = '👻-rerun-existing';
    const playerStart = room.players[first.playerId].waypoints[0].startTime;
    this.send(first, {
      type: 'ADD_GHOSTS',
      ghosts: [{ playerName: 'rerun-existing', color: '#888', waypoints: [{ x: 0, y: 0, startTime: playerStart, arrivalTime: playerStart, speedFactor: 1 }] }],
    }, 'RACE_AGAIN_GUARD_EXISTING_GHOST');
    assert(room.players[existingGhostId].finishTime === 0, 'existing rerun ghost did not finish');
    const elapsed = Math.max(1, room.virtualTime - (room.gameStartTime ?? room.virtualTime));
    this.send(first, { type: 'PLAYER_FINISHED', finishTime: elapsed }, 'RACE_AGAIN_GUARD_FIRST_FINISHED');
    this.send(second, { type: 'PLAYER_FINISHED', finishTime: elapsed + 1 }, 'RACE_AGAIN_GUARD_SECOND_FINISHED');
    this.send(first, { type: 'RACE_AGAIN', waypoints: clone(room.players[first.playerId].waypoints) }, 'RACE_AGAIN_GUARD_EARLY');
    assert(room.state === 'RUNNING', 'race again reset before every connected player finished');

    this.record({ action: 'RACE_AGAIN_GUARD_DISCONNECT_THIRD', client: third.id });
    third.connected = false;
    for (const subscribers of this.subscriptions.values()) subscribers.delete(third.id);
    handleGameClose(this.rooms, third.wsData, this.hooksFor(third), this.updateRoom);

    const ghostCount = Object.values(room.players).filter((player) => player.isGhost).length;
    this.send(first, { type: 'RACE_AGAIN', waypoints: clone(room.players[first.playerId].waypoints) }, 'RACE_AGAIN_GUARD_AFTER_DISCONNECT');
    const rerunRoom = this.rooms.get(roomId)!;
    assert(rerunRoom.state === 'JOINING', 'race again did not ignore disconnected unfinished player');
    assert(Object.values(rerunRoom.players).filter((player) => player.isGhost).length === ghostCount + 2, 'race again did not create ghosts for every connected finisher');
    assert(rerunRoom.players[existingGhostId].finishTime === null, 'race again did not re-arm an existing ghost');

    const retainedGhostIds = Object.values(rerunRoom.players).filter((player) => player.isGhost).map((player) => player.id);
    const nextStartTime = rerunRoom.initialStartTime + 60_000;
    this.send(second, {
      type: 'SET_GAME_BOUNDS', startPos: rerunRoom.startPos, finishPos: rerunRoom.finishPos,
      startTime: nextStartTime, difficulty: 'Normal', computerDriver: true,
      ghosts: false, league: rerunRoom.league,
    }, 'RACE_AGAIN_GUARD_CHANGE_SETTINGS');
    assert(rerunRoom.state === 'JOINING' && rerunRoom.isRerun, 'settings change left rerun setup');
    assert(retainedGhostIds.every((id) => Object.prototype.hasOwnProperty.call(rerunRoom.players, id)), 'non-positional settings change removed a ghost');
    assert(Object.values(rerunRoom.players).filter((player) => !player.isGhost).every((player) => !player.isReady), 'settings change readied a player');

    const inboxStart = first.inbox.length;
    this.send(first, {
      type: 'SET_GAME_BOUNDS', startPos: [rerunRoom.startPos[0] + 0.001, rerunRoom.startPos[1]], finishPos: rerunRoom.finishPos,
      startTime: nextStartTime, difficulty: rerunRoom.difficulty, computerDriver: rerunRoom.computerDriver,
      ghosts: false, league: rerunRoom.league,
    }, 'RACE_AGAIN_GUARD_CHANGE_POSITION');
    assert(retainedGhostIds.every((id) => !Object.prototype.hasOwnProperty.call(rerunRoom.players, id)), 'position change retained a ghost');
    for (const ghostId of retainedGhostIds) {
      const leaves = first.inbox.slice(inboxStart).filter((message) => isMessage(message, 'PLAYER_LEFT') && message.playerId === ghostId);
      assert(leaves.length === 1, `position change emitted ${leaves.length} leave events for ${ghostId}`);
    }
  }

  private disconnect() {
    const client = this.rng.pick(this.connectedClients());
    this.record({ action: 'DISCONNECT', client: client.id });
    client.connected = false;
    for (const subscribers of this.subscriptions.values()) subscribers.delete(client.id);
    handleGameClose(this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
  }

  private closeStaleConnection() {
    const client = this.rng.pick(this.joinedClients());
    this.record({ action: 'STALE_CLOSE', client: client.id });
    handleGameClose(this.rooms, { ...client.wsData }, this.hooksFor(), this.updateRoom);
  }

  private addWaypoint() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const waypoint = this.nextWaypointFor(client);
    this.send(client, { type: 'ADD_WAYPOINT', ...waypoint }, 'ADD_WAYPOINT');
  }

  private addWalkingWaypoint() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const waypoint = this.nextWaypointFor(client);
    const { arrivalTime: _arrivalTime, ...walkingWaypoint } = waypoint;
    this.send(client, { type: 'ADD_WAYPOINT', ...walkingWaypoint, speedFactor: 1, isWalk: true }, 'ADD_WALKING_WAYPOINT');
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

  private addPlannedService() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    const last = player.waypoints[player.waypoints.length - 1];
    const walkArrival = Math.max(last.arrivalTime, room.virtualTime) + 10_000;
    const waitArrival = walkArrival + 45_000;
    const firstStopArrival = waitArrival + 30_000;
    const finalArrival = firstStopArrival + 90_000;
    const stationX = last.x + this.deltaCoord();
    const stationY = last.y + this.deltaCoord();
    const waypoints: Array<Omit<Waypoint, 'startTime'>> = [
      { x: stationX, y: stationY, arrivalTime: walkArrival, speedFactor: 1, stopName: 'walk to station', isWalk: true, emoji: '🐾' },
      { x: stationX, y: stationY, arrivalTime: waitArrival, speedFactor: 1, stopName: 'waiting for planned service', isWait: true, emoji: '⏳' },
      { x: stationX + this.deltaCoord(), y: stationY + this.deltaCoord(), arrivalTime: firstStopArrival, speedFactor: 20, stopName: 'through stop', isInterstop: true, route_short_name: 'FZ' },
      { x: stationX + this.deltaCoord(), y: stationY + this.deltaCoord(), arrivalTime: finalArrival, speedFactor: 20, stopName: 'planned final stop', route_short_name: 'FZ' },
    ];
    this.send(client, { type: 'ADD_WAYPOINTS_BATCH', waypoints }, 'ADD_PLANNED_SERVICE');
  }

  private addStaleTeleport() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    const beforeCount = player.waypoints.length;
    const last = player.waypoints[player.waypoints.length - 1];
    const staleArrival = room.virtualTime - 1 - this.rng.int(5000);
    const waypoint: Omit<Waypoint, 'startTime'> = {
      x: this.safeX(last.x + this.deltaCoord()),
      y: this.safeY(last.y + this.deltaCoord()),
      arrivalTime: staleArrival,
      speedFactor: 1,
      stopName: 'stale teleport',
    };
    this.send(client, { type: 'ADD_WAYPOINTS_BATCH', waypoints: [waypoint] }, 'ADD_STALE_TELEPORT');
    assert(player.waypoints.length === beforeCount + 1, `stale teleport was rejected for ${client.id}`);
    assert(player.waypoints[player.waypoints.length - 1].arrivalTime >= Math.max(last.arrivalTime, room.virtualTime), `stale teleport was not clamped for ${client.id}`);
  }

  private addRailStyleEarlyBatch() {
    const client = this.rng.pick(this.routingClients());
    this.syncRoomFor(client);
    const room = this.rooms.get(client.wsData.roomId!)!;
    const player = room.players[client.wsData.playerId!];
    const beforeCount = player.waypoints.length;
    const last = player.waypoints[player.waypoints.length - 1];
    const start = Math.max(last.arrivalTime, room.virtualTime);
    const stationX = this.safeX(last.x + this.deltaCoord());
    const stationY = this.safeY(last.y + this.deltaCoord());
    const waypoints: Array<Omit<Waypoint, 'startTime'>> = [
      { x: stationX, y: stationY, arrivalTime: start + 90_000, speedFactor: 1, stopName: 'walk to rail', isWalk: true, emoji: '🐾' },
      { x: this.safeX(stationX + this.deltaCoord()), y: this.safeY(stationY + this.deltaCoord()), arrivalTime: start + 5_000, speedFactor: 20, stopName: 'early rail interstop', isInterstop: true, route_short_name: 'R' },
      { x: this.safeX(stationX + this.deltaCoord()), y: this.safeY(stationY + this.deltaCoord()), arrivalTime: start + 20_000, speedFactor: 20, stopName: 'early rail stop', route_short_name: 'R', route_departure_time: '12:00' },
    ];
    this.send(client, { type: 'ADD_WAYPOINTS_BATCH', waypoints }, 'ADD_RAIL_EARLY_BATCH');
    assert(player.waypoints.length === beforeCount + waypoints.length, `rail-style early batch was rejected for ${client.id}`);
  }

  private advanceToNextWaypointEvent() {
    const candidates = Array.from(this.rooms.values()).filter((room) => room.state === 'RUNNING' && this.subscriberCount(room.id) > 0 && room.playbackRate > 0 && this.nextWaypointEvent(room) !== null);
    if (candidates.length === 0) return this.advanceTime();
    const room = this.rng.pick(candidates);
    this.updateRoom(room.id);
    const nextEvent = this.nextWaypointEvent(room);
    if (nextEvent === null) return;
    const ms = Math.max(60, Math.ceil((nextEvent - room.virtualTime) / room.playbackRate) + 60);
    this.record({ action: 'ADVANCE_TO_WAYPOINT_EVENT', message: { roomId: room.id, nextEvent, ms } });
    this.clock.advance(ms);
    const updatedRoom = this.rooms.get(room.id);
    assert(!updatedRoom || updatedRoom.state !== 'RUNNING' || updatedRoom.virtualTime >= nextEvent, `room ${room.id} did not progress to waypoint event ${nextEvent}`);
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

  private reusableRoomClients() {
    return Array.from(this.rooms.values()).flatMap((room) => {
      if (room.state !== 'RUNNING') return [];
      const clients = this.joinedClients().filter((client) => client.wsData.roomId === room.id);
      return clients.length >= 2 ? clients : [];
    });
  }

  private reuseFinishedRoom() {
    const client = this.rng.pick(this.reusableRoomClients());
    const roomId = client.wsData.roomId!;
    const roomClients = this.joinedClients().filter((candidate) => candidate.wsData.roomId === roomId);
    for (const candidate of roomClients) {
      const room = this.rooms.get(roomId);
      if (!room || room.state !== 'RUNNING') return;
      const player = room.players[candidate.wsData.playerId!];
      if (player.finishTime !== null) continue;
      if (player.waypoints.length === 1) {
        const waypoint = this.nextWaypointFor(candidate);
        this.send(candidate, { type: 'ADD_WAYPOINT', ...waypoint }, 'REUSE_ADD_WAYPOINT');
      }
      const updatedRoom = this.rooms.get(roomId)!;
      const elapsed = Math.max(1, updatedRoom.virtualTime - (updatedRoom.gameStartTime ?? updatedRoom.virtualTime));
      this.send(candidate, { type: 'PLAYER_FINISHED', finishTime: elapsed }, 'REUSE_PLAYER_FINISHED');
    }
    const updatedRoom = this.rooms.get(roomId);
    if (!updatedRoom) return;
    const sender = roomClients.find((candidate) => updatedRoom.players[candidate.wsData.playerId!]?.waypoints.length > 1) ?? roomClients[0];
    const senderPlayer = updatedRoom.players[sender.wsData.playerId!];
    this.send(sender, { type: 'RACE_AGAIN', waypoints: clone(senderPlayer.waypoints) }, 'REUSE_RACE_AGAIN');
    const resetRoom = this.rooms.get(roomId);
    assert(resetRoom?.state === 'JOINING', `room ${roomId} was not reusable after RACE_AGAIN`);
    for (const candidate of roomClients) {
      const resetPlayer = resetRoom.players[candidate.wsData.playerId!];
      assert(resetPlayer.finishTime === null, `player ${candidate.wsData.playerId} stayed finished after room reuse`);
      assert(!resetPlayer.isReady, `player ${candidate.wsData.playerId} stayed ready after room reuse`);
      assert(resetPlayer.waypoints.length === 1, `player ${candidate.wsData.playerId} kept old route after room reuse`);
    }
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

  private jumpServerClockBackward() {
    const rooms = Array.from(this.rooms.values());
    if (rooms.length === 0) return this.advanceTime();
    const room = this.rng.pick(rooms);
    this.updateRoom(room.id);
    const before = room.virtualTime;
    const ms = 1 + this.rng.int(5 * 60_000);
    this.record({ action: 'SERVER_CLOCK_ROLLBACK', message: { roomId: room.id, ms } });
    this.clock.shiftWallTime(-ms);
    this.updateRoom(room.id);
    assert(room.virtualTime >= before, `room ${room.id} rewound after server clock rollback`);
    this.clock.shiftWallTime(ms);
    this.updateRoom(room.id);
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
      { type: 'JOIN_ROOM', roomId: `${client.roomId}\0other`, playerId: client.playerId },
      { type: 'JOIN_ROOM', roomId: client.roomId, playerId: `poison-${this.currentStep}`, color: { invalid: true } },
      { type: 'SET_GAME_BOUNDS', startPos: {}, finishPos: [], league: null },
      { type: 'SET_GAME_BOUNDS', startPos, finishPos, startTime: this.clock.nowMs, difficulty: { nope: true }, computerDriver: false, ghosts: false, league: 'not_a_league' },
      { type: 'TOGGLE_READY' },
      { type: 'SET_VIEWING_STOP', stopName: { definitely: 'not a stop name' } },
      { type: 'UPDATE_PLAYER_COLOR', color: { hue: 120 } },
      { type: 'ADD_WAYPOINTS_BATCH', waypoints: [null] },
      { type: 'ADD_WAYPOINTS_BATCH', waypoints: [{ x: startPos[1], y: startPos[0], arrivalTime: this.clock.nowMs + 60_000, speedFactor: 10, isWalk: { wrong: true }, route_short_name: { also: 'wrong' } }] },
      { type: 'ADD_WAYPOINT', x: Number.POSITIVE_INFINITY, y: {}, speedFactor: 'fast' },
      { type: 'ADD_WAYPOINT', x: startPos[1], y: startPos[0], arrivalTime: Number.MAX_VALUE, speedFactor: Number.MAX_VALUE },
      { type: 'ADD_WAYPOINT', x: startPos[1], y: startPos[0], arrivalTime: this.clock.nowMs + 60_000, speedFactor: 10, isWait: { wrong: true }, emoji: { nope: true } },
      { type: 'PLAYER_FINISHED', finishTime: Number.NaN },
      { type: 'PLAYER_FINISHED', finishTime: Number.MAX_VALUE },
      { type: 'RACE_AGAIN', waypoints: [] },
      { type: 'ADD_GHOSTS', ghosts: [{ playerName: 'bad', waypoints: [] }] },
      { type: 'ADD_GHOSTS', ghosts: [{ playerName: 'bad-colour', color: { hue: 20 }, waypoints: ghostWaypoints }] },
      { type: 'PLAYER_KICK', playerId: realPlayerId },
      { type: 'SEND_PING', lat: Number.POSITIVE_INFINITY, lon: Number.NEGATIVE_INFINITY },
    ];
    this.send(client, this.rng.pick(malformed), 'HOSTILE_MESSAGE');
  }

  private sendMalformedFrame() {
    const client = this.rng.pick(this.connectedClients());
    const frames: Array<string | Uint8Array> = [
      '', '{', 'null', '[]', 'true', '"text"',
      '{"type":"UNKNOWN"}', '{"type":',
      new Uint8Array([0xff, 0x00, 0x7b, 0x7d]),
    ];
    const frame = this.rng.pick(frames);
    this.record({ action: 'MALFORMED_FRAME', client: client.id, message: typeof frame === 'string' ? frame : Array.from(frame) });
    const beforeRooms = formatJson(Array.from(this.rooms.entries()));
    const beforeData = formatJson(client.wsData);
    const beforeInboxLengths = this.clients.map((candidate) => candidate.inbox.length);
    const parsed = parseWebSocketMessage(frame);
    if (parsed !== undefined) handleIncomingMessage(parsed, this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
    assert(formatJson(Array.from(this.rooms.entries())) === beforeRooms, 'malformed frame mutated room state');
    assert(formatJson(client.wsData) === beforeData, 'malformed frame mutated connection identity');
    assert(this.clients.every((candidate, index) => candidate.inbox.length === beforeInboxLengths[index]), 'malformed frame emitted a server message');
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

  private safeX(value: number) {
    return Math.max(-179, Math.min(179, value));
  }

  private safeY(value: number) {
    return Math.max(-89, Math.min(89, value));
  }

  private colorFor(client: Client) {
    const hue = Number(client.id.replace('client-', '')) * 70;
    return `hsl(${hue % 360}, 70%, 50%)`;
  }

  private assertInvariants() {
    this.assertInboxMessages();

    const seenTimerIds = new Set<number>();
    for (const [roomId, subscribers] of this.subscriptions) {
      assert(this.rooms.has(roomId), `subscriptions exist for missing room ${roomId}`);
      for (const clientId of subscribers) {
        const client = this.clients.find((candidate) => candidate.id === clientId);
        assert(client?.connected, `${clientId} is subscribed to ${roomId} but is not connected`);
        assert(client.wsData.roomId === roomId, `${clientId} is subscribed to ${roomId} but joined ${client.wsData.roomId}`);
      }
    }

    for (const client of this.clients) {
      if (!client.connected || !client.wsData.roomId || !client.wsData.playerId) continue;
      const room = this.rooms.get(client.wsData.roomId);
      assert(room && Object.prototype.hasOwnProperty.call(room.players, client.wsData.playerId), `${client.id} is connected but missing player ${client.wsData.playerId}`);
      assert(room.players[client.wsData.playerId].disconnectedAt === null, `${client.id} is connected but player ${client.wsData.playerId} is marked disconnected`);
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
      const subscriberCount = this.subscriberCount(roomId);
      if (subscriberCount > 0) assert(room.emptySince === null, `room ${roomId} has subscribers but emptySince ${room.emptySince}`);
      if (room.emptySince !== null) {
        assert(subscriberCount === 0, `room ${roomId} is marked empty with ${subscriberCount} subscribers`);
        assert(this.clock.nowMs - room.emptySince <= 60_000, `empty room ${roomId} was not deleted after idle timeout`);
      }

      if (room.state === 'JOINING') {
        assert(room.countdownEnd === null, `room ${roomId} is JOINING with countdownEnd ${room.countdownEnd}`);
        assert(room.gameStartTime === null, `room ${roomId} is JOINING with gameStartTime ${room.gameStartTime}`);
      }
      if (room.state === 'COUNTDOWN') {
        assert(finiteNumber(room.countdownEnd), `room ${roomId} is COUNTDOWN without finite countdownEnd`);
        const activeRealPlayers = Object.values(room.players).filter((player) => !player.isGhost && !player.disconnectedAt);
        assert(activeRealPlayers.length > 0, `room ${roomId} is COUNTDOWN with no connected real players`);
        assert(activeRealPlayers.every((player) => player.isReady), `room ${roomId} is COUNTDOWN but not all connected real players are ready`);
      }
      if (room.state === 'JOINING') {
        const activeRealPlayers = Object.values(room.players).filter((player) => !player.isGhost && !player.disconnectedAt);
        assert(activeRealPlayers.length === 0 || activeRealPlayers.some((player) => !player.isReady), `room ${roomId} is JOINING even though all connected real players are ready`);
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
        const timerAt = this.clock.timerAt(room.timerId);
        assert(timerAt === undefined || timerAt >= this.clock.nowMs, `room ${roomId} has overdue timer ${room.timerId}`);
      }

      this.assertPlayers(room);
    }

    assert(this.clock.activeTimerCount() <= this.rooms.size, `too many active timers: ${this.clock.activeTimerCount()} for ${this.rooms.size} rooms`);
  }

  private assertInboxMessages() {
    for (const client of this.clients) {
      for (let i = client.checkedInboxLength; i < client.inbox.length; i++) {
        assertServerMessage(client.inbox[i], `${client.id} inbox ${i}`);
      }
      client.checkedInboxLength = client.inbox.length;
    }
  }

  private cleanupAndAssert() {
    for (const client of this.connectedClients()) {
      this.record({ action: 'FINAL_DISCONNECT', client: client.id });
      client.connected = false;
      for (const subscribers of this.subscriptions.values()) subscribers.delete(client.id);
      handleGameClose(this.rooms, client.wsData, this.hooksFor(client), this.updateRoom);
    }
    this.clock.advance(61_000);
    this.assertInvariants();
    assert(this.rooms.size === 0, `cleanup left ${this.rooms.size} rooms`);
    assert(this.clock.activeTimerCount() === 0, `cleanup left ${this.clock.activeTimerCount()} timers`);
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
      const hasConnection = this.clients.some((client) => client.connected && client.wsData.roomId === room.id && client.wsData.playerId === playerId);
      if (room.state !== 'RUNNING' && !player.isGhost) {
        assert(player.finishTime === null, `waiting player ${playerId} still has finishTime ${player.finishTime}`);
      }
      if (!player.isGhost && player.disconnectedAt !== null) {
        assert(!hasConnection, `player ${playerId} is connected and marked disconnected`);
        if (room.emptySince === null) assert(this.clock.nowMs - player.disconnectedAt <= 60_050, `disconnected player ${playerId} was not deleted after idle timeout`);
      }
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
      if (player.isGhost || player.disconnectedAt !== null || player.finishTime !== null) continue;
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

  private nextWaypointEvent(room: Room) {
    let nextEvent = Number.POSITIVE_INFINITY;
    for (const player of Object.values(room.players)) {
      if (player.isGhost || player.finishTime !== null) continue;
      for (const waypoint of player.waypoints) {
        if (waypoint.startTime > room.virtualTime) nextEvent = Math.min(nextEvent, waypoint.startTime);
        if (waypoint.startTime <= room.virtualTime && waypoint.arrivalTime > room.virtualTime) nextEvent = Math.min(nextEvent, waypoint.arrivalTime);
      }
    }
    return Number.isFinite(nextEvent) ? nextEvent : null;
  }
}

function isMessage(message: unknown, type: string): message is Record<string, any> {
  return !!message && typeof message === 'object' && (message as { type?: unknown }).type === type;
}

function assertServerMessage(message: unknown, label: string) {
  assert(message && typeof message === 'object', `${label} is not an object`);
  const msg = message as Record<string, any>;
  assert(typeof msg.type === 'string', `${label} has invalid type`);

  if (msg.type === 'ROOM_STATE' || msg.type === 'ROOM_STATE_UPDATE') {
    assertRoomStateMessage(msg, label, msg.type === 'ROOM_STATE');
    return;
  }
  if (msg.type === 'SYNC_RESPONSE') {
    assert(msg.clientSendTime === undefined || finiteNumber(msg.clientSendTime), `${label} has invalid clientSendTime`);
    assert(finiteNumber(msg.serverTime), `${label} has invalid serverTime`);
    assert(finiteNumber(msg.realTime), `${label} has invalid realTime`);
    assert(finiteNumber(msg.rate) && msg.rate >= 0, `${label} has invalid rate`);
    return;
  }
  if (msg.type === 'CLOCK_UPDATE') {
    assert(finiteNumber(msg.serverTime), `${label} has invalid serverTime`);
    assert(finiteNumber(msg.realTime), `${label} has invalid realTime`);
    assert(finiteNumber(msg.rate) && msg.rate >= 0, `${label} has invalid rate`);
    return;
  }
  if (msg.type === 'PLAYER_JOINED') {
    assertPlayerMessage(msg.player, `${label}.player`);
    if (msg.playerId !== undefined) assert(msg.playerId === msg.player.id, `${label} playerId does not match player.id`);
    return;
  }
  if (msg.type === 'PLAYER_LEFT') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    return;
  }
  if (msg.type === 'READY_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(typeof msg.isReady === 'boolean', `${label} has invalid isReady`);
    return;
  }
  if (msg.type === 'PLAYER_COLOR_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(typeof msg.color === 'string', `${label} has invalid color`);
    return;
  }
  if (msg.type === 'PLAYER_SNOOZE_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(finiteNumber(msg.desiredRate), `${label} has invalid desiredRate`);
    assert(typeof msg.forceRealtime === 'boolean', `${label} has invalid forceRealtime`);
    return;
  }
  if (msg.type === 'PLAYER_DISCONNECT_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(msg.disconnectedAt === null || finiteNumber(msg.disconnectedAt), `${label} has invalid disconnectedAt`);
    return;
  }
  if (msg.type === 'PLAYER_VIEW_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(msg.viewingStopName === null || typeof msg.viewingStopName === 'string', `${label} has invalid viewingStopName`);
    return;
  }
  if (msg.type === 'PLAYER_FINISH_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(msg.finishTime === null || finiteNumber(msg.finishTime), `${label} has invalid finishTime`);
    return;
  }
  if (msg.type === 'PLAYER_WAYPOINTS_UPDATE') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(Array.isArray(msg.waypoints) && msg.waypoints.length > 0, `${label} has invalid waypoints`);
    msg.waypoints.forEach((waypoint: Waypoint, index: number) => assertWaypoint(waypoint, `${label}.waypoints[${index}]`));
    return;
  }
  if (msg.type === 'WAYPOINT_ADDED') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assertWaypoint(msg.waypoint, `${label}.waypoint`);
    return;
  }
  if (msg.type === 'RECV_PING') {
    assert(typeof msg.playerId === 'string', `${label} has invalid playerId`);
    assert(finiteNumber(msg.lat) && msg.lat >= -90 && msg.lat <= 90, `${label} has invalid lat`);
    assert(finiteNumber(msg.lon) && msg.lon >= -180 && msg.lon <= 180, `${label} has invalid lon`);
    assert(finiteNumber(msg.timestamp), `${label} has invalid timestamp`);
    return;
  }

  assert(false, `${label} has unknown message type ${msg.type}`);
}

function assertRoomStateMessage(msg: Record<string, any>, label: string, expectPlayers: boolean) {
  assert(msg.state === 'JOINING' || msg.state === 'COUNTDOWN' || msg.state === 'RUNNING', `${label} has invalid state`);
  assert(msg.countdownEnd === null || finiteNumber(msg.countdownEnd), `${label} has invalid countdownEnd`);
  assert(msg.gameStartTime === null || finiteNumber(msg.gameStartTime), `${label} has invalid gameStartTime`);
  assertCoord(msg.startPos, `${label}.startPos`);
  if (msg.finishPos !== null) assertCoord(msg.finishPos, `${label}.finishPos`);
  assert(msg.difficulty === 'Easy' || msg.difficulty === 'Normal' || msg.difficulty === 'Transport nerd', `${label} has invalid difficulty`);
  assert(typeof msg.league === 'string' && /^\d{8}$/.test(msg.league), `${label} has invalid league`);
  assert(finiteNumber(msg.serverTime), `${label} has invalid serverTime`);
  assert(finiteNumber(msg.realTime), `${label} has invalid realTime`);
  assert(typeof msg.isRerun === 'boolean', `${label} has invalid isRerun`);
  assert(finiteNumber(msg.rate) && msg.rate >= 0, `${label} has invalid rate`);
  if (expectPlayers) {
    assert(msg.players && typeof msg.players === 'object' && !Array.isArray(msg.players), `${label} has invalid players`);
    for (const [playerId, player] of Object.entries(msg.players)) {
      assertPlayerMessage(player, `${label}.players.${playerId}`);
      assert((player as { id: string }).id === playerId, `${label}.players.${playerId} key/id mismatch`);
    }
  }
}

function assertPlayerMessage(value: unknown, label: string) {
  assert(value && typeof value === 'object', `${label} is not an object`);
  const player = value as Record<string, any>;
  assert(typeof player.id === 'string', `${label} has invalid id`);
  assert(typeof player.color === 'string', `${label} has invalid color`);
  assert(typeof player.isReady === 'boolean', `${label} has invalid isReady`);
  assert(Array.isArray(player.waypoints) && player.waypoints.length > 0, `${label} has invalid waypoints`);
  assert(finiteNumber(player.desiredRate), `${label} has invalid desiredRate`);
  assert(typeof player.forceRealtime === 'boolean', `${label} has invalid forceRealtime`);
  assert(player.finishTime === null || finiteNumber(player.finishTime), `${label} has invalid finishTime`);
  assert(player.disconnectedAt === null || finiteNumber(player.disconnectedAt), `${label} has invalid disconnectedAt`);
  assert(player.viewingStopName === null || typeof player.viewingStopName === 'string', `${label} has invalid viewingStopName`);
  assert(typeof player.isGhost === 'boolean', `${label} has invalid isGhost`);
  player.waypoints.forEach((waypoint: Waypoint, index: number) => assertWaypoint(waypoint, `${label}.waypoints[${index}]`));
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
