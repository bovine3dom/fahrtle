import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { getRealTime, type Room, type Waypoint } from '../src/shared/gameLogic';
import { restoreStoredWaypoints } from '../src/shared/waypointPersistence';
import { buildRenderablePlayer, getPlayerMotionAt } from '../src/playerRendering';

const waypoints: Waypoint[] = [
  { x: 0, y: 0, startTime: 0, arrivalTime: 0, speedFactor: 1 },
  { x: 1, y: 1, startTime: 0, arrivalTime: 1, speedFactor: 1 },
  { x: 10, y: 10, startTime: 5, arrivalTime: 10, speedFactor: 1 },
];

test('legacy ghost records traverse pruned interstop intervals instead of waiting', () => {
  const restored = restoreStoredWaypoints(JSON.parse(JSON.stringify(waypoints)));
  const ghost = buildRenderablePlayer({ waypoints: restored, isGhost: true }, 100);
  expect(getPlayerMotionAt(ghost, 103)?.position).toEqual([3, 3]);
  expect(getPlayerMotionAt(ghost, 110)?.position).toEqual([10, 10]);
  expect(waypoints[2].startTime).toBe(5);
  expect(restoreStoredWaypoints({ version: 1, waypoints: restored })).toEqual(restored);
});

test('versioned records keep genuine gaps even without interstop points', () => {
  const restored = restoreStoredWaypoints(JSON.parse(JSON.stringify({ version: 1, waypoints })));
  const ghost = buildRenderablePlayer({ waypoints: restored, isGhost: true }, 100);
  expect(getPlayerMotionAt(ghost, 103)?.position).toEqual([1, 1]);
  expect(getPlayerMotionAt(ghost, 107.5)?.position).toEqual([5.5, 5.5]);
  expect(restored).toEqual(waypoints);
});

test('legacy restoration keeps initial delays and explicit stationary waits', () => {
  const restored = restoreStoredWaypoints([
    waypoints[0],
    { ...waypoints[1], startTime: 2, arrivalTime: 3 },
    { ...waypoints[1], startTime: 3, arrivalTime: 5, isWait: true },
    { ...waypoints[2], startTime: 8 },
  ]);
  const player = buildRenderablePlayer({ waypoints: restored });
  expect(getPlayerMotionAt(player, 1)?.position).toEqual([0, 0]);
  expect(getPlayerMotionAt(player, 4)?.position).toEqual([1, 1]);
  expect(getPlayerMotionAt(player, 7.5)?.position).toEqual([5.5, 5.5]);
});

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  mock.restore();
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('solo saves migrate all legacy players once and preserve new gaps on reload', async () => {
  spyOn(performance, 'now').mockReturnValue(0);
  spyOn(globalThis, 'setInterval').mockReturnValue(0 as any);
  spyOn(globalThis, 'setTimeout').mockReturnValue(0 as any);
  let stored: string | null = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
    removeItem: () => { stored = null; },
  } });
  const { FakeServer } = await import('../src/fakeServer');
  const room: Room = {
    id: 'solo', state: 'RUNNING', countdownEnd: null, emptySince: null,
    gameStartTime: 0, startPos: [0, 0], finishPos: [10, 10], virtualTime: 0,
    lastRealTime: getRealTime(), playbackRate: 1, initialStartTime: 0,
    difficulty: 'Easy', isRerun: false, league: '20260706', players: {},
  };
  for (const id of ['player', 'ghost']) {
    room.players[id] = {
      id, color: '#888', isReady: true, waypoints, desiredRate: 1,
      forceRealtime: false, finishTime: null, disconnectedAt: null,
      viewingStopName: null, isGhost: id === 'ghost',
    };
  }
  stored = JSON.stringify({ solo: room });
  for (const expectedStart of [1, 5]) {
    const server = new FakeServer();
    expect(server.hasPersistentGame()).toBe(true);
    const socket = server.connect('solo', 'player');
    let snapshot: any;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'ROOM_STATE') snapshot = message;
    };
    socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: 'solo', playerId: 'player' }));
    for (const player of Object.values(snapshot.players) as Room['players'][string][]) {
      expect(player.waypoints[2].startTime).toBe(expectedStart);
    }
    const saved = JSON.parse(stored!);
    expect(saved.version).toBe(1);
    // Replace a migrated route with a newly recorded gap before the next reload.
    for (const player of Object.values(saved.rooms.solo.players) as Room['players'][string][]) {
      player.waypoints = waypoints;
    }
    stored = JSON.stringify(saved);
  }
  stored = JSON.stringify({ version: 1, rooms: {} });
  expect(new FakeServer().hasPersistentGame()).toBe(false);
});
