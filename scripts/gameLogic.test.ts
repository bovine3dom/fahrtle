import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { getRealTime, handleIncomingMessage, updateRoomLogic, type GameHooks, type Room } from '../src/shared/gameLogic';

let room: Room;
let elapsed: number;
let hooks: GameHooks;

beforeEach(() => {
  elapsed = 0;
  spyOn(performance, 'now').mockImplementation(() => elapsed);
  room = {
    id: 'room', state: 'RUNNING', countdownEnd: null, emptySince: null,
    gameStartTime: 0, startPos: [0, 0], finishPos: [1, 1], virtualTime: 0,
    lastRealTime: getRealTime() - 50, playbackRate: 500, initialStartTime: 0,
    difficulty: 'Easy', isRerun: false, league: '20260706',
    players: {
      player: {
        id: 'player', color: '#888', isReady: true, desiredRate: 1,
        forceRealtime: false, finishTime: null, disconnectedAt: null,
        viewingStopName: null, isGhost: false,
        waypoints: [
          { x: 0, y: 0, startTime: 0, arrivalTime: 0, speedFactor: 1 },
          { x: 1, y: 1, startTime: 0, arrivalTime: 1000, speedFactor: 500 },
          { x: 2, y: 2, startTime: 1000, arrivalTime: 1010, speedFactor: 1 },
          { x: 3, y: 3, startTime: 1010, arrivalTime: 1_000_000, speedFactor: 500 },
        ],
      },
    },
  };
  hooks = {
    publish: mock(() => {}), broadcastRoomState: () => {},
    getSubscriberCount: () => 1, sendToSender: () => {}, subscribeToRoom: () => {},
  };
});

afterEach(() => {
  clearTimeout(room.timerId);
  mock.restore();
});

test('publishes a corrected anchor after crossing rates and returning to the original rate', () => {
  updateRoomLogic(room, hooks, () => {});
  expect(room.virtualTime).toBe(20_010);
  expect(hooks.publish).toHaveBeenCalledWith(room.id, {
    type: 'CLOCK_UPDATE', serverTime: 20_010, realTime: getRealTime(), rate: 500,
  });

  elapsed += 1000;
  updateRoomLogic(room, hooks, () => {});
  expect(room.virtualTime).toBe(520_010);
  expect(hooks.publish).toHaveBeenCalledTimes(1);
});

test('commits and publishes the effective rate after a single rate change', () => {
  room.players.player.waypoints[3].speedFactor = 1;
  updateRoomLogic(room, hooks, () => {});
  expect(room.virtualTime).toBe(1048);
  expect(room.playbackRate).toBe(1);
  expect(hooks.publish).toHaveBeenCalledWith(room.id, {
    type: 'CLOCK_UPDATE', serverTime: 1048, realTime: getRealTime(), rate: 1,
  });
});

test('a second clock advance in a message handler uses the committed rate', () => {
  room.players.player.waypoints[3].speedFactor = 1;
  hooks.publish = () => { elapsed += 5; };
  handleIncomingMessage(
    { type: 'ADD_WAYPOINTS_BATCH', waypoints: [] }, new Map([[room.id, room]]),
    { roomId: room.id, playerId: 'player' }, hooks, () => {},
  );
  expect(room.virtualTime).toBe(1053);
  expect(room.playbackRate).toBe(1);
});
