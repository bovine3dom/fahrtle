// src/shared/gameLogic.ts
import simplify from 'simplify-js';
import { haversineDist } from '../utils/geo';
import { generatePilotName } from '../names';
export const CURRENT_LEAGUE = "20260706";

const COUNTDOWN_DURATION = import.meta.env.PROD ? 5000 : 100;

export type Difficulty = 'Easy' | 'Normal' | 'Transport nerd';

export type GameBounds = {
    start: [number, number] | null;
    finish: [number, number] | null;
    time?: number;
    difficulty: Difficulty;
    computerDriver?: boolean;
    ghosts?: boolean;
    league: string;
};

export function getRoomBounds(room: Room): GameBounds {
    return {
        start: room.startPos,
        finish: room.finishPos,
        difficulty: room.difficulty,
        computerDriver: room.computerDriver,
        ghosts: room.ghosts,
        league: room.league,
    };
}

export function boundsToWire(bounds: GameBounds) {
    return {
        startPos: bounds.start,
        finishPos: bounds.finish,
        startTime: bounds.time,
        difficulty: bounds.difficulty,
        computerDriver: bounds.computerDriver,
        ghosts: bounds.ghosts,
        league: bounds.league,
    };
}

export function wireToGameBounds(msg: any): GameBounds {
    return {
        start: msg.startPos,
        finish: msg.finishPos,
        time: msg.serverTime ?? msg.startTime,
        difficulty: msg.difficulty || 'Normal',
        computerDriver: msg.computerDriver,
        ghosts: msg.ghosts,
        league: msg.league,
    };
}

export type Waypoint = {
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
    timeStr?: string;
    isInterstop?: boolean;
    isWait?: boolean;
};

export type Player = {
    id: string;
    color: string;
    isReady: boolean;
    waypoints: Waypoint[];
    desiredRate: number; // 1.0 or 500.0
    forceRealtime: boolean; // explicitly force 1x regardless of waypoint speed
    finishTime: number | null;
    disconnectedAt: number | null;
    viewingStopName: string | null;
    isGhost: boolean;
};

export type Room = {
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
    initialStartTime: number;

    // Game Loop
    timerId?: ReturnType<typeof setTimeout>;

    difficulty: Difficulty;
    computerDriver?: boolean;
    ghosts?: boolean;

    isRerun: boolean;
    league: string;
};

const BASE_SPEED = 5 / (60 * 60 * 1000); // 5 km/h in km/ms
const MAX_IDLE_TIME = 60000; // 1 minute cleanup check
const MAX_TIMESTAMP = 10_000_000_000_000;
const MAX_SPEED_FACTOR = 1_000_000;
let realTimeAnchor: { wallTime: number; monotonicTime: number } | null = null;

export function getRealTime() {
    const monotonicTime = performance.now();
    realTimeAnchor ??= { wallTime: Date.now(), monotonicTime };
    return realTimeAnchor.wallTime + monotonicTime - realTimeAnchor.monotonicTime;
}

export function reanchorRoomRealTime(room: Room, now = getRealTime()) {
    const offset = now - room.lastRealTime;
    room.lastRealTime = now;
    if (room.countdownEnd !== null) room.countdownEnd += offset;
    if (room.emptySince !== null) room.emptySince += offset;
    for (const player of Object.values(room.players)) {
        if (player.disconnectedAt !== null) player.disconnectedAt += offset;
    }
}

function lerp(v0: number, v1: number, t: number) {
    return v0 * (1 - t) + v1 * t;
}

function pushMinHeap(heap: number[], value: number) {
    let index = heap.length;
    heap.push(value);
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent] <= value) break;
        heap[index] = heap[parent];
        index = parent;
    }
    heap[index] = value;
}

function popMinHeap(heap: number[]) {
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && heap[right] < heap[left] ? right : left;
        if (heap[child] >= last) break;
        heap[index] = heap[child];
        index = child;
    }
    heap[index] = last;
}

function minHeapValue(heap: number[], isCurrent: (value: number) => boolean) {
    while (heap.length > 0 && !isCurrent(heap[0])) popMinHeap(heap);
    return heap[0];
}

function getSpawnPoint(centerLat: number, centerLng: number) {
    const spreadMeters = 50;
    const latOffset = (Math.random() - 0.5) * 2 * (spreadMeters / 111111);
    const longitudeScale = Math.cos(centerLat * Math.PI / 180);
    const lngOffset = Math.abs(longitudeScale) < 1e-6
        ? 0
        : (Math.random() - 0.5) * 2 * (spreadMeters / (111111 * longitudeScale));

    return {
        x: ((centerLng + lngOffset + 540) % 360) - 180,
        y: Math.max(-90, Math.min(90, centerLat + latOffset))
    };
}

function stepClock(room: Room) {
    const now = getRealTime();
    room.virtualTime = getProjectedRoomTime(room, now);
    room.lastRealTime = now;
}

export function getProjectedRoomTime(room: Room, now = getRealTime()) {
    return getProjectedRoomClock(room, now).virtualTime;
}

export function getProjectedRoomClock(room: Room, now = getRealTime()) {
    if (room.state !== 'RUNNING') return { virtualTime: room.virtualTime, playbackRate: 0 };
    let remainingRealTime = Math.max(0, now - room.lastRealTime);
    let virtualTime = room.virtualTime;
    let rate = room.playbackRate;

    if (remainingRealTime <= 0 || rate <= 0) return { virtualTime, playbackRate: rate };

    const states: {
        player: Player;
        activeWaypoints: number[];
        activeWaypointSet: Set<number>;
        factor: number;
    }[] = [];
    const events: { time: number; playerIndex: number; waypointIndex: number; active: boolean }[] = [];
    const factorHeap: number[] = [];
    const factorCounts = new Map<number, number>();
    const addFactor = (factor: number) => {
        const count = factorCounts.get(factor) ?? 0;
        factorCounts.set(factor, count + 1);
        if (count === 0) pushMinHeap(factorHeap, factor);
    };
    const removeFactor = (factor: number) => {
        const count = factorCounts.get(factor) ?? 0;
        if (count <= 1) factorCounts.delete(factor);
        else factorCounts.set(factor, count - 1);
    };
    const getPlayerFactor = (state: typeof states[number]) => {
        if (state.player.forceRealtime) return 1;
        const desiredRate = state.player.desiredRate || 1;
        const waypointIndex = minHeapValue(state.activeWaypoints, (index) => state.activeWaypointSet.has(index));
        return waypointIndex === undefined
            ? desiredRate
            : Math.max(state.player.waypoints[waypointIndex].speedFactor, desiredRate);
    };

    for (const player of Object.values(room.players)) {
        if (player.isGhost || player.disconnectedAt !== null || player.finishTime !== null) continue;
        const playerIndex = states.length;
        const state = { player, activeWaypoints: [] as number[], activeWaypointSet: new Set<number>(), factor: 1 };
        states.push(state);
        for (let waypointIndex = 0; waypointIndex < player.waypoints.length; waypointIndex++) {
            const waypoint = player.waypoints[waypointIndex];
            if (waypoint.arrivalTime <= waypoint.startTime) continue;
            if (virtualTime >= waypoint.startTime && virtualTime < waypoint.arrivalTime) {
                state.activeWaypointSet.add(waypointIndex);
                pushMinHeap(state.activeWaypoints, waypointIndex);
            }
            if (waypoint.startTime > virtualTime) events.push({ time: waypoint.startTime, playerIndex, waypointIndex, active: true });
            if (waypoint.arrivalTime > virtualTime) events.push({ time: waypoint.arrivalTime, playerIndex, waypointIndex, active: false });
        }
        state.factor = getPlayerFactor(state);
        addFactor(state.factor);
    }

    events.sort((a, b) => a.time - b.time);
    let eventIndex = 0;
    while (eventIndex < events.length && remainingRealTime > 0 && rate > 0) {
        const boundary = events[eventIndex].time;
        const realTimeToBoundary = (boundary - virtualTime) / rate;
        if (realTimeToBoundary > remainingRealTime) return { virtualTime: virtualTime + remainingRealTime * rate, playbackRate: rate };
        virtualTime = boundary;
        remainingRealTime -= realTimeToBoundary;
        const affectedPlayers = new Set<number>();
        while (eventIndex < events.length && events[eventIndex].time === boundary) {
            const event = events[eventIndex++];
            const state = states[event.playerIndex];
            if (event.active) {
                state.activeWaypointSet.add(event.waypointIndex);
                pushMinHeap(state.activeWaypoints, event.waypointIndex);
            } else {
                state.activeWaypointSet.delete(event.waypointIndex);
            }
            affectedPlayers.add(event.playerIndex);
        }
        for (const playerIndex of affectedPlayers) {
            const state = states[playerIndex];
            const nextFactor = getPlayerFactor(state);
            if (nextFactor === state.factor) continue;
            removeFactor(state.factor);
            state.factor = nextFactor;
            addFactor(nextFactor);
        }
        rate = Math.max(1, minHeapValue(factorHeap, (factor) => factorCounts.has(factor)) ?? 1);
    }
    if (remainingRealTime > 0 && rate > 0) virtualTime += remainingRealTime * rate;
    return { virtualTime, playbackRate: rate };
}

function playbackRateAt(room: Room, virtualTime: number) {
    const activeFactors: number[] = [];
    for (const player of Object.values(room.players)) {
        if (player.isGhost || player.disconnectedAt !== null || player.finishTime !== null) continue;
        let currentFactor = player.forceRealtime ? 1 : (player.desiredRate || 1);
        for (const waypoint of player.waypoints) {
            if (virtualTime >= waypoint.startTime && virtualTime < waypoint.arrivalTime) {
                currentFactor = player.forceRealtime ? 1 : Math.max(waypoint.speedFactor, player.desiredRate || 1);
                break;
            }
        }
        activeFactors.push(currentFactor);
    }
    return activeFactors.length > 0 ? Math.max(1, Math.min(...activeFactors)) : 1;
}

export interface GameHooks {
    broadcastRoomState: (room: Room) => void;
    publish: (roomId: string, message: any) => void;
    getSubscriberCount: (roomId: string) => number;
    onRoomDeleted?: (roomId: string) => void;
    sendToSender: (message: any) => void;
    subscribeToRoom: (roomId: string) => void;
    unsubscribeFromRoom?: (roomId: string) => void;
    shouldDeletePlayer?: (roomId: string, playerId: string) => boolean;
}

function markPlayerDisconnected(
    room: Room,
    roomId: string,
    playerId: string,
    hooks: GameHooks,
    updateRoom: (room: Room) => void
) {
    const player = room.players[playerId];
    if (!player) return;
    if (hooks.shouldDeletePlayer && !hooks.shouldDeletePlayer(roomId, playerId)) return;

    stepClock(room);
    player.disconnectedAt = getRealTime();
    hooks.publish(roomId, { type: 'PLAYER_DISCONNECT_UPDATE', playerId, disconnectedAt: player.disconnectedAt });
    checkCountdownLogic(room, hooks);

    const roomConnections = hooks.getSubscriberCount(roomId);
    if (roomConnections > 0) {
        player.forceRealtime = false;
        player.desiredRate = 500.0;
        hooks.publish(roomId, {
            type: 'PLAYER_SNOOZE_UPDATE',
            playerId,
            desiredRate: player.desiredRate,
            forceRealtime: player.forceRealtime
        });
    } else {
        room.emptySince = getRealTime();
        room.playbackRate = 0;
    }
    updateRoom(room);
}

function scheduleNextTick(room: Room, updateCallback: (roomId: string) => void) {
    if (room.timerId) {
        clearTimeout(room.timerId);
        room.timerId = undefined;
    }

    const now = getRealTime();
    let delay = MAX_IDLE_TIME;

    if (room.emptySince !== null) {
        delay = Math.min(delay, room.emptySince + MAX_IDLE_TIME - now);
    }

    for (const player of Object.values(room.players)) {
        if (player.disconnectedAt) delay = Math.min(delay, player.disconnectedAt + MAX_IDLE_TIME - now);
    }

    if (room.state === 'COUNTDOWN' && room.countdownEnd) {
        const timeToStart = room.countdownEnd - now;
        delay = Math.max(0, timeToStart);
    }
    else if (room.state === 'RUNNING' && room.playbackRate > 0) {
        let nextVirtualEvent = Number.MAX_VALUE;

        for (const pid in room.players) {
            const p = room.players[pid];
            for (const wp of p.waypoints) {
                if (wp.startTime > room.virtualTime) {
                    nextVirtualEvent = Math.min(nextVirtualEvent, wp.startTime);
                }
                if (wp.startTime <= room.virtualTime && wp.arrivalTime > room.virtualTime) {
                    nextVirtualEvent = Math.min(nextVirtualEvent, wp.arrivalTime);
                }
            }
        }

        if (nextVirtualEvent !== Number.MAX_VALUE) {
            const virtualDiff = nextVirtualEvent - room.virtualTime;
            const realDiff = virtualDiff / room.playbackRate;
            delay = Math.min(delay, realDiff + 10);  // add buffer to make sure we're overdue
        }
    }

    delay = Math.max(50, Math.min(delay, MAX_IDLE_TIME));

    room.timerId = setTimeout(() => {
        updateCallback(room.id);
    }, delay);
}

function processRouteSteps(steps: any[], coords: number[][], startTime: number) {
    const allTimedPoints: any[] = [];
    let runningTime = startTime;

    for (const step of steps) {
        const [startIdx, endIdx] = step.way_points;
        const stepDurationMs = step.duration * 1000;
        const stepPoints = coords.slice(startIdx, endIdx + 1);

        const stepDistances = [0];
        let totalStepDist = 0;
        for (let j = 1; j < stepPoints.length; j++) {
            totalStepDist += haversineDist({ lon: stepPoints[j - 1][0], lat: stepPoints[j - 1][1] }, { lon: stepPoints[j][0], lat: stepPoints[j][1] }) || 0;
            stepDistances.push(totalStepDist);
        }

        for (let j = 0; j < stepPoints.length; j++) {
            if (j === 0 && allTimedPoints.length > 0) continue;
            const ratio = totalStepDist === 0 ? 0 : stepDistances[j] / totalStepDist;
            allTimedPoints.push({ x: stepPoints[j][0], y: stepPoints[j][1], arrivalTime: runningTime + (ratio * stepDurationMs), instruction: step.instruction });
        }
        runningTime += stepDurationMs;
    }
    return allTimedPoints;
}

function buildDrivingWaypoints(simplifiedPoints: { x: number, y: number, arrivalTime: number, instruction: string }[], startTime: number): Waypoint[] {
    const REST_STOP_INTERVAL = 2 * 60 * 60 * 1000;
    const REST_STOP_DURATION = 15 * 60 * 1000;
    const SLEEP_INTERVAL = 16 * 60 * 60 * 1000;
    const SLEEP_DURATION = 8 * 60 * 60 * 1000;

    const waypoints: Waypoint[] = [];
    let driveTimeSinceLastRest = 0;
    let driveTimeSinceLastSleep = 0;
    let totalDelay = 0;

    for (let i = 0; i < simplifiedPoints.length; i++) {
        const curr = simplifiedPoints[i];
        const prev = i > 0 ? simplifiedPoints[i - 1] : null;
        const segmentDriveTime = prev ? (curr.arrivalTime - prev.arrivalTime) : 0;
        driveTimeSinceLastRest += segmentDriveTime;
        driveTimeSinceLastSleep += segmentDriveTime;

        const isStart = i === 0;
        const isEnd = i === simplifiedPoints.length - 1;
        waypoints.push({
            x: curr.x, y: curr.y,
            startTime: isStart ? startTime : waypoints[waypoints.length - 1].arrivalTime,
            arrivalTime: curr.arrivalTime + totalDelay,
            speedFactor: 1.0,
            stopName: isStart ? 'Starting' : (isEnd ? 'Destination' : curr.instruction),
            emoji: '🚗'
        });

        if (driveTimeSinceLastSleep >= SLEEP_INTERVAL) {
            const sleepStart = curr.arrivalTime + totalDelay;
            waypoints.push({ x: curr.x, y: curr.y, startTime: sleepStart, arrivalTime: sleepStart + SLEEP_DURATION, speedFactor: 1.0, stopName: 'sleeping', emoji: '😴' });
            totalDelay += SLEEP_DURATION;
            driveTimeSinceLastSleep = 0;
            driveTimeSinceLastRest = 0;
        } else if (driveTimeSinceLastRest >= REST_STOP_INTERVAL) {
            const restStart = curr.arrivalTime + totalDelay;
            waypoints.push({ x: curr.x, y: curr.y, startTime: restStart, arrivalTime: restStart + REST_STOP_DURATION, speedFactor: 1.0, stopName: 'taking a break', emoji: '☕' });
            totalDelay += REST_STOP_DURATION;
            driveTimeSinceLastRest = 0;
        }
    }
    return waypoints;
}

async function fetchComputerDriverRoute(room: Room, hooks: GameHooks) {
    if (!room.startPos || !room.finishPos) return;
    const requestedStart = [...room.startPos] as [number, number];
    const requestedFinish = [...room.finishPos] as [number, number];

    try {
        const body = JSON.stringify({
            coordinates: [[requestedStart[1], requestedStart[0]], [requestedFinish[1], requestedFinish[0]]]
        });

        const response = await fetch("https://compute.olie.science/heigit-ors/v2/directions/driving-car/geojson", {
            method: 'POST',
            headers: { 'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8', 'Content-Type': 'application/json' },
            body
        });

        if (!response.ok) throw new Error(`ORS API error: ${response.status}`);

        const data = await response.json();
        const feature = data.features[0];
        if (!feature) return;
        if (!room.computerDriver || room.state !== 'RUNNING' || room.players['the-stig-🏎️']
            || room.startPos[0] !== requestedStart[0] || room.startPos[1] !== requestedStart[1]
            || room.finishPos?.[0] !== requestedFinish[0] || room.finishPos[1] !== requestedFinish[1]) return;

        const coords = feature.geometry.coordinates;
        const steps = feature.properties.segments[0].steps;
        const startTime = room.gameStartTime ?? room.virtualTime;

        const allTimedPoints = processRouteSteps(steps, coords, startTime);
        const simplified = simplify(allTimedPoints, 0.0005, true) as { x: number, y: number, arrivalTime: number, instruction: string }[];
        const finalWaypoints = buildDrivingWaypoints(simplified, startTime);

        room.players['the-stig-🏎️'] = {
            id: 'the-stig-🏎️', color: '#000000', isReady: true, waypoints: finalWaypoints,
            desiredRate: 1e9, forceRealtime: false, finishTime: null,
            disconnectedAt: null, viewingStopName: null, isGhost: true
        };

        hooks.publish(room.id, { type: 'PLAYER_JOINED', player: room.players['the-stig-🏎️'] });

    } catch (e) {
        console.error("Failed to fetch computer driver route", e);
    }
}

function requireRoomAndPlayer(
    wsData: { roomId: string | null, playerId: string | null },
    rooms: Map<string, Room>,
    opts: { requireRunning?: boolean } = {}
): { room: Room; player: Player } | null {
    if (!wsData.roomId || !wsData.playerId) return null;
    const room = rooms.get(wsData.roomId);
    if (!room) return null;
    if (opts.requireRunning && room.state !== 'RUNNING') return null;
    const player = Object.prototype.hasOwnProperty.call(room.players, wsData.playerId) ? room.players[wsData.playerId] : undefined;
    if (!player) return null;
    return { room, player };
}

function isObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
}

function isSafeKey(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
        && value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function isFiniteCoord(value: unknown): value is [number, number] {
    return Array.isArray(value) && value.length === 2
        && Number.isFinite(value[0]) && Number.isFinite(value[1])
        && value[0] >= -90 && value[0] <= 90
        && value[1] >= -180 && value[1] <= 180;
}

function isDifficulty(value: unknown): value is Difficulty {
    return value === 'Easy' || value === 'Normal' || value === 'Transport nerd';
}

function isLeague(value: unknown): value is string {
    return typeof value === 'string' && /^\d{8}$/.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP;
}

function isSafeSpeedFactor(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SPEED_FACTOR;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function normalizeGhostWaypoints(value: unknown): Waypoint[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const normalized: Waypoint[] = [];
    let previousArrival: number | undefined;
    for (const wp of value) {
        if (!isObject(wp)
            || !Number.isFinite(wp.x) || wp.x < -180 || wp.x > 180
            || !Number.isFinite(wp.y) || wp.y < -90 || wp.y > 90
            || !isSafeTimestamp(wp.startTime)
            || !isSafeTimestamp(wp.arrivalTime)
            || !isSafeSpeedFactor(wp.speedFactor)
            || [wp.stopName, wp.route_color, wp.route_short_name, wp.display_name, wp.emoji, wp.route_departure_time, wp.timeStr]
                .some(field => field != null && typeof field !== 'string')
            || [wp.isWalk, wp.isWait, wp.isInterstop]
                .some(field => field != null && typeof field !== 'boolean')) return null;

        let startTime = wp.startTime;
        let arrivalTime = wp.arrivalTime;
        if (previousArrival !== undefined && (startTime < previousArrival || arrivalTime < startTime)) startTime = previousArrival;
        arrivalTime = Math.max(arrivalTime, startTime);
        normalized.push({
            x: wp.x, y: wp.y, startTime, arrivalTime, speedFactor: wp.speedFactor,
            stopName: optionalString(wp.stopName), isWalk: optionalBoolean(wp.isWalk),
            isWait: optionalBoolean(wp.isWait), isInterstop: optionalBoolean(wp.isInterstop),
            route_color: optionalString(wp.route_color), route_short_name: optionalString(wp.route_short_name),
            display_name: optionalString(wp.display_name), emoji: optionalString(wp.emoji),
            route_departure_time: optionalString(wp.route_departure_time), timeStr: optionalString(wp.timeStr)
        });
        previousArrival = arrivalTime;
    }
    return normalized;
}

function buildWaypoint(wp: any, lastPoint: Waypoint, roomTime: number): Waypoint | null {
    if (!isObject(wp)
        || !Number.isFinite(wp.x) || wp.x < -180 || wp.x > 180
        || !Number.isFinite(wp.y) || wp.y < -90 || wp.y > 90
        || !isSafeSpeedFactor(wp.speedFactor)) return null;

    const start = Math.max(lastPoint.arrivalTime, roomTime);
    if (!isSafeTimestamp(start)) return null;
    let finalArrival = wp.arrivalTime;
    if (finalArrival === undefined) {
        const distance = haversineDist({ lat: lastPoint.y, lon: lastPoint.x }, { lat: wp.y, lon: wp.x }) || 0;
        finalArrival = start + distance / BASE_SPEED;
    }
    if (!isSafeTimestamp(finalArrival)) return null;
    finalArrival = Math.max(finalArrival, start);

    return {
        x: wp.x, y: wp.y, startTime: start, arrivalTime: finalArrival,
        speedFactor: wp.speedFactor, stopName: optionalString(wp.stopName),
        isWalk: wp.isWalk === true, isWait: wp.isWait === true, isInterstop: wp.isInterstop === true,
        route_color: optionalString(wp.route_color), route_short_name: optionalString(wp.route_short_name),
        display_name: optionalString(wp.display_name), emoji: wp.isWalk === true ? '🐾' : (wp.isWait === true ? '⏳' : optionalString(wp.emoji)),
        route_departure_time: optionalString(wp.route_departure_time), timeStr: optionalString(wp.timeStr)
    };
}

function handleSyncRequest(message: any, rooms: Map<string, Room>, hooks: GameHooks) {
    const now = getRealTime();
    const targetRoomId = message.roomId;
    let serverTime = now;
    let rate = 1.0;

    if (targetRoomId && rooms.has(targetRoomId)) {
        const r = rooms.get(targetRoomId)!;
        const projectedClock = getProjectedRoomClock(r);
        serverTime = projectedClock.virtualTime;
        rate = projectedClock.playbackRate;
    }

    hooks.sendToSender({
        type: 'SYNC_RESPONSE',
        clientSendTime: message.clientSendTime,
        serverTime,
        realTime: now,
        rate: (targetRoomId && rooms.get(targetRoomId)?.state === 'RUNNING') ? rate : 0
    });
}

function handleJoinRoom(
    message: any,
    rooms: Map<string, Room>,
    wsData: { roomId: string | null, playerId: string | null },
    hooks: GameHooks,
    triggerUpdate: (rid: string) => void
) {
    const now = getRealTime();
    const { roomId, playerId, color } = message;
    if (!isSafeKey(roomId) || !isSafeKey(playerId)) return;
    const previousRoomId = wsData.roomId;
    const previousPlayerId = wsData.playerId;
    const switchedPlayer = !!previousRoomId && !!previousPlayerId && (previousRoomId !== roomId || previousPlayerId !== playerId);

    let room = rooms.get(roomId);
    if (!room) {
        room = {
            id: roomId, players: {}, state: 'JOINING', countdownEnd: null,
            startPos: [55.9533, -3.1883], finishPos: [43.7101, 7.2660],
            emptySince: null, gameStartTime: null, virtualTime: now,
            lastRealTime: now, playbackRate: 1.0, initialStartTime: now,
            isRerun: false, league: CURRENT_LEAGUE, difficulty: 'Easy'
        };
        rooms.set(roomId, room);
    }

    stepClock(room);
    room.emptySince = null;

    if (!Object.prototype.hasOwnProperty.call(room.players, playerId)) {
        const spawn = getSpawnPoint(room.startPos[0], room.startPos[1]);
        room.players[playerId] = {
            id: playerId,
            color: typeof color === 'string' ? color : ('#' + Math.floor(Math.random() * 16777215).toString(16)),
            isReady: room.state === 'RUNNING',
            waypoints: [{ x: spawn.x, y: spawn.y, startTime: room.virtualTime, arrivalTime: room.virtualTime, speedFactor: 1 }],
            desiredRate: 1, forceRealtime: false, finishTime: null,
            disconnectedAt: null, viewingStopName: null, isGhost: false
        };
    } else {
        const player = room.players[playerId];
        if (player) {
            player.disconnectedAt = null;
            if (player.desiredRate === 500.0) player.desiredRate = 1.0;
        }
    }

    if (switchedPlayer) hooks.unsubscribeFromRoom?.(previousRoomId);
    wsData.roomId = roomId;
    wsData.playerId = playerId;
    hooks.subscribeToRoom(roomId);

    if (switchedPlayer) {
        const previousRoom = rooms.get(previousRoomId);
        if (previousRoom) markPlayerDisconnected(previousRoom, previousRoomId, previousPlayerId, hooks, (r) => triggerUpdate(r.id));
    }

    checkCountdownLogic(room, hooks);

    hooks.sendToSender({
        type: 'ROOM_STATE', state: room.state, countdownEnd: room.countdownEnd,
        gameStartTime: room.gameStartTime, serverTime: room.virtualTime,
        ...boundsToWire(getRoomBounds(room)), isRerun: room.isRerun,
        realTime: now, rate: room.state === 'RUNNING' ? playbackRateAt(room, room.virtualTime) : 0,
        players: room.players
    });

    hooks.publish(roomId, { type: 'PLAYER_JOINED', player: room.players[playerId] });
    triggerUpdate(roomId);
}

function handleRaceAgain(
    wsData: { roomId: string | null, playerId: string | null },
    result: { room: Room; player: Player },
    hooks: GameHooks,
    triggerUpdate: (rid: string) => void
) {
    const { room } = result;
    const activePlayers = Object.values(room.players).filter(p => !p.isGhost && p.disconnectedAt === null);
    if (activePlayers.length === 0 || activePlayers.some(p => p.finishTime === null)) return;
    const ghosts = activePlayers.map((p) => {
        const ghostId = `👻-${generatePilotName()}`;
        const ghost: Player = {
            id: ghostId, color: p.color, isReady: true,
            waypoints: p.waypoints, desiredRate: 1e9, forceRealtime: false,
            finishTime: null, disconnectedAt: null, viewingStopName: null, isGhost: true
        };
        room.players[ghostId] = ghost;
        return ghost;
    });

    room.state = 'JOINING';
    room.virtualTime = room.initialStartTime;
    room.countdownEnd = null;
    room.gameStartTime = null;
    room.isRerun = true;

    for (const pid of Object.keys(room.players)) {
        const p = room.players[pid];
        if (p.isGhost) {
            if (p.finishTime !== null) {
                p.finishTime = null;
                hooks.publish(wsData.roomId!, { type: 'PLAYER_FINISH_UPDATE', playerId: pid, finishTime: null });
            }
            continue;
        }
        const spawn = getSpawnPoint(room.startPos[0], room.startPos[1]);
        p.waypoints = [{ x: spawn.x, y: spawn.y, startTime: room.initialStartTime, arrivalTime: room.initialStartTime, speedFactor: 1 }];
        p.isReady = false;
        p.finishTime = null;
        p.desiredRate = 1;
        p.forceRealtime = false;
        p.viewingStopName = null;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_FINISH_UPDATE', playerId: pid, finishTime: null });
        hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: pid, waypoints: p.waypoints });
        hooks.publish(wsData.roomId!, { type: 'READY_UPDATE', playerId: pid, isReady: false });
        hooks.publish(wsData.roomId!, { type: 'PLAYER_SNOOZE_UPDATE', playerId: pid, desiredRate: p.desiredRate, forceRealtime: p.forceRealtime });
        hooks.publish(wsData.roomId!, { type: 'PLAYER_VIEW_UPDATE', playerId: pid, viewingStopName: p.viewingStopName });
    }
    for (const ghost of ghosts) {
        hooks.publish(wsData.roomId!, { type: 'PLAYER_JOINED', playerId: ghost.id, player: ghost });
    }
    hooks.broadcastRoomState(room);
    triggerUpdate(wsData.roomId!);
}

function handleSetGameBounds(
    message: any,
    wsData: { roomId: string | null, playerId: string | null },
    room: Room,
    hooks: GameHooks,
    triggerUpdate: (rid: string) => void
) {
    if (room.state !== 'JOINING') return;
    if (!isFiniteCoord(message.startPos)) return;
    if (message.finishPos !== null && !isFiniteCoord(message.finishPos)) return;
    if (message.startTime !== undefined && !isSafeTimestamp(message.startTime)) return;
    if (!isDifficulty(message.difficulty)) return;
    if (!isLeague(message.league)) return;

    const prevStart = room.startPos;
    const prevFinish = room.finishPos;
    const prevStartTime = room.initialStartTime;
    const prevGhosts = room.ghosts;
    const prevDifficulty = room.difficulty;
    const prevComputerDriver = room.computerDriver;
    const prevLeague = room.league;
    room.startPos = message.startPos;
    room.finishPos = message.finishPos;
    room.difficulty = message.difficulty || 'Normal';
    room.computerDriver = !!message.computerDriver;
    room.ghosts = !!message.ghosts;
    room.league = message.league;

    if (message.startTime !== undefined) {
        room.virtualTime = message.startTime;
        room.initialStartTime = message.startTime;
    }

    if (room.startPos) {
        const [newLat, newLng] = room.startPos;
        const posChanged = !prevStart || prevStart[0] !== newLat || prevStart[1] !== newLng;
        const finishChanged = prevFinish === null || room.finishPos === null
            ? prevFinish !== room.finishPos
            : prevFinish[0] !== room.finishPos[0] || prevFinish[1] !== room.finishPos[1];
        const positionChanged = posChanged || finishChanged;
        const timeChanged = message.startTime !== undefined && message.startTime !== prevStartTime;
        const resetPlayers = posChanged || timeChanged;
        const ghostsDisabled = prevGhosts === true && !room.ghosts;
        const settingsChanged = positionChanged || timeChanged || prevDifficulty !== room.difficulty
            || prevComputerDriver !== room.computerDriver || prevGhosts !== room.ghosts || prevLeague !== room.league;

        for (const pid of Object.keys(room.players)) {
            if (room.players[pid].isGhost) {
                if (positionChanged || timeChanged || ghostsDisabled || (pid === 'the-stig-🏎️' && !room.computerDriver)) {
                    delete room.players[pid];
                    hooks.publish(wsData.roomId!, { type: 'PLAYER_LEFT', playerId: pid });
                }
                continue;
            }
            const p = room.players[pid];
            if (settingsChanged && p.isReady) {
                p.isReady = false;
                hooks.publish(wsData.roomId!, { type: 'READY_UPDATE', playerId: pid, isReady: false });
            }
            if (!resetPlayers) continue;
            const spawn = getSpawnPoint(newLat, newLng);
            p.waypoints = [{ x: spawn.x, y: spawn.y, startTime: room.virtualTime, arrivalTime: room.virtualTime, speedFactor: 1 }];
            p.viewingStopName = null;
            hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: pid, waypoints: p.waypoints });
        }
    }
    hooks.broadcastRoomState(room);
    triggerUpdate(wsData.roomId!);
}

function handleStopImmediately(
    message: any,
    wsData: { roomId: string | null, playerId: string | null },
    result: { room: Room; player: Player },
    hooks: GameHooks,
    triggerUpdate: (rid: string) => void
) {
    const { room, player } = result;
    stepClock(room);
    const vTime = room.virtualTime;

    if (message.destinationWpIndex !== undefined) {
        const idx = message.destinationWpIndex;
        if (idx >= 0 && idx < player.waypoints.length) {
            player.waypoints = player.waypoints.slice(0, idx + 1);
            player.viewingStopName = null;
            hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: wsData.playerId, waypoints: player.waypoints });
            triggerUpdate(wsData.roomId!);
            return;
        }
    }

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
            currentPos = { x: nextWp.x, y: nextWp.y };
        } else {
            currentPos = { x: prevWp.x, y: prevWp.y };
        }
    } else {
        const last = player.waypoints[player.waypoints.length - 1];
        currentPos = { x: last.x, y: last.y };
    }

    if (nextWpIndex !== -1) {
        const nextWp = player.waypoints[nextWpIndex];
        const prevWp = player.waypoints[nextWpIndex - 1] || player.waypoints[0];
        const segStartTime = Math.max(prevWp.arrivalTime, nextWp.startTime);
        player.waypoints = [
            ...player.waypoints.slice(0, nextWpIndex),
            { x: currentPos.x, y: currentPos.y, startTime: segStartTime, arrivalTime: vTime, speedFactor: 1, stopName: 'Stopped' }
        ];
    } else {
        const last = player.waypoints[player.waypoints.length - 1];
        if (last) { last.stopName = 'Stopped'; last.arrivalTime = Math.min(last.arrivalTime, vTime); }
    }

    player.viewingStopName = null;
    hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: wsData.playerId, waypoints: player.waypoints });
    triggerUpdate(wsData.roomId!);
}

export function handleIncomingMessage(
    message: any,
    rooms: Map<string, Room>,
    wsData: { roomId: string | null, playerId: string | null },
    hooks: GameHooks,
    updateRoomCallback: (roomId: string) => void
) {
    if (!isObject(message)) return;

    const triggerUpdate = (rid: string) => {
        const r = rooms.get(rid);
        if (r) updateRoomLogic(r, hooks, updateRoomCallback);
    };

    if (message.type === 'SYNC_REQUEST') { handleSyncRequest(message, rooms, hooks); return; }
    if (message.type === 'JOIN_ROOM') { handleJoinRoom(message, rooms, wsData, hooks, triggerUpdate); return; }

    if (message.type === 'TOGGLE_READY') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        if (r.room.state === 'RUNNING') return;
        r.player.isReady = !r.player.isReady;
        hooks.publish(wsData.roomId!, { type: 'READY_UPDATE', playerId: wsData.playerId, isReady: r.player.isReady });
        checkCountdownLogic(r.room, hooks);
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'RACE_AGAIN') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        handleRaceAgain(wsData, r, hooks, triggerUpdate);
        return;
    }

    if (message.type === 'ADD_GHOSTS') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const { ghosts } = message;
        if (!Array.isArray(ghosts)) return;
        for (const ghostData of ghosts) {
            if (!isObject(ghostData) || typeof ghostData.playerName !== 'string') continue;
            const waypoints = normalizeGhostWaypoints(ghostData.waypoints);
            if (!waypoints) continue;
            const { playerName, color } = ghostData;
            const ghostId = `👻-${playerName}`;
            if (!isSafeKey(ghostId)) continue;
            const ghost: Player = {
                id: ghostId, color: typeof color === 'string' ? color : `hsl(${Math.floor(Math.random() * 360)}, 30%, 50%)`,
                isReady: true, waypoints, desiredRate: 1e9, forceRealtime: false,
                finishTime: null, disconnectedAt: null, viewingStopName: null, isGhost: true
            };
            room.players[ghostId] = ghost;
            hooks.publish(wsData.roomId, { type: 'PLAYER_JOINED', playerId: ghostId, player: ghost });
        }
        hooks.broadcastRoomState(room);
        triggerUpdate(wsData.roomId);
        return;
    }

    if (message.type === 'UPDATE_PLAYER_COLOR') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        if (typeof message.color !== 'string') return;
        r.player.color = message.color;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_COLOR_UPDATE', playerId: wsData.playerId, color: r.player.color });
        return;
    }

    if (message.type === 'TOGGLE_SNOOZE') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        stepClock(r.room);
        r.player.forceRealtime = false;
        r.player.desiredRate = r.player.desiredRate > 1.0 ? 1.0 : 500.0;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_SNOOZE_UPDATE', playerId: wsData.playerId, desiredRate: r.player.desiredRate, forceRealtime: r.player.forceRealtime });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'FORCE_REALTIME') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        stepClock(r.room);
        r.player.forceRealtime = !r.player.forceRealtime;
        if (r.player.forceRealtime) r.player.desiredRate = 1.0;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_SNOOZE_UPDATE', playerId: wsData.playerId, desiredRate: r.player.desiredRate, forceRealtime: r.player.forceRealtime });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'SET_GAME_BOUNDS') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        handleSetGameBounds(message, wsData, room, hooks, triggerUpdate);
        return;
    }

    if (message.type === 'SET_VIEWING_STOP') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        if (message.stopName !== null && typeof message.stopName !== 'string') return;
        r.player.viewingStopName = message.stopName;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_VIEW_UPDATE', playerId: wsData.playerId, viewingStopName: r.player.viewingStopName });
        return;
    }

    if (message.type === 'ADD_WAYPOINTS_BATCH') {
        const r = requireRoomAndPlayer(wsData, rooms, { requireRunning: true });
        if (!r) return;
        stepClock(r.room);
        const { waypoints } = message;
        if (!Array.isArray(waypoints) || waypoints.length === 0) { triggerUpdate(wsData.roomId!); return; }
        const nextWaypoints: Waypoint[] = [];
        let lastPoint = r.player.waypoints[r.player.waypoints.length - 1];
        for (const wp of waypoints) {
            const next = buildWaypoint(wp, lastPoint, r.room.virtualTime);
            if (!next) { triggerUpdate(wsData.roomId!); return; }
            nextWaypoints.push(next);
            lastPoint = next;
        }
        r.player.viewingStopName = null;
        r.player.waypoints.push(...nextWaypoints);
        hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: wsData.playerId, waypoints: r.player.waypoints });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'ADD_WAYPOINT') {
        const r = requireRoomAndPlayer(wsData, rooms, { requireRunning: true });
        if (!r) return;
        stepClock(r.room);
        const { x, y, speedFactor, arrivalTime, stopName, isWalk, isWait, route_color, route_short_name, display_name, emoji, route_departure_time, timeStr, isInterstop } = message;
        const lastPoint = r.player.waypoints[r.player.waypoints.length - 1];
        const newWaypoint = buildWaypoint({ x, y, speedFactor, arrivalTime, stopName, isWalk, isWait, route_color, route_short_name, display_name, emoji, route_departure_time, timeStr, isInterstop }, lastPoint, r.room.virtualTime);
        if (!newWaypoint) { triggerUpdate(wsData.roomId!); return; }
        r.player.viewingStopName = null;
        r.player.waypoints.push(newWaypoint);
        hooks.publish(wsData.roomId!, { type: 'WAYPOINT_ADDED', playerId: wsData.playerId, waypoint: newWaypoint });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'STOP_IMMEDIATELY') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        handleStopImmediately(message, wsData, r, hooks, triggerUpdate);
        return;
    }

    if (message.type === 'PLAYER_FINISHED') {
        const r = requireRoomAndPlayer(wsData, rooms, { requireRunning: true });
        if (!r || r.player.finishTime !== null || !isSafeTimestamp(message.finishTime) || message.finishTime < 0) return;
        stepClock(r.room);
        r.player.finishTime = message.finishTime;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_FINISH_UPDATE', playerId: wsData.playerId, finishTime: r.player.finishTime });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'PLAYER_KICK') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const { playerId } = message;
        if (!isSafeKey(playerId) || !Object.prototype.hasOwnProperty.call(room.players, playerId)) return;
        if (!room.players[playerId].isGhost) return;
        delete room.players[playerId];
        hooks.publish(wsData.roomId, { type: 'PLAYER_LEFT', playerId });
        checkCountdownLogic(room, hooks);
        hooks.broadcastRoomState(room);
        return;
    }

    if (message.type === 'SEND_PING') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        const { lat, lon } = message;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
        hooks.publish(wsData.roomId!, { type: 'RECV_PING', playerId: wsData.playerId, lat, lon, timestamp: getRealTime() });
    }
}

function checkCountdownLogic(room: Room, hooks: GameHooks) {
    const activePlayers = Object.values(room.players).filter(p => !p.isGhost && !p.disconnectedAt);
    const allReady = activePlayers.length > 0 && activePlayers.every(p => p.isReady);

    if (room.state === 'JOINING' && allReady) {
        room.state = 'COUNTDOWN';
        room.countdownEnd = getRealTime() + COUNTDOWN_DURATION;
        hooks.broadcastRoomState(room);
    } else if (room.state === 'COUNTDOWN' && !allReady) {
        room.state = 'JOINING';
        room.countdownEnd = null;
        hooks.broadcastRoomState(room);
    }
}

function calculatePlaybackRate(room: Room, hooks: GameHooks) {
    const newRate = playbackRateAt(room, room.virtualTime);
    if (Math.abs(room.playbackRate - newRate) > 0.01) {
        room.playbackRate = newRate;
        hooks.publish(room.id, { type: 'CLOCK_UPDATE', serverTime: room.virtualTime, realTime: getRealTime(), rate: room.playbackRate });
    }
}

function checkGhostFinishes(room: Room, hooks: GameHooks) {
    const ghosts = Object.values(room.players).filter(p => p.isGhost);
    const playerStart = room.gameStartTime ?? room.initialStartTime;
    for (const ghost of ghosts) {
        if (ghost.finishTime !== null || ghost.waypoints.length === 0) continue;
        const offset = playerStart - ghost.waypoints[0].startTime;
        const lastWp = ghost.waypoints[ghost.waypoints.length - 1];
        const finishVirtualTime = offset + lastWp.arrivalTime;
        if (room.virtualTime >= finishVirtualTime) {
            ghost.finishTime = Math.max(0, finishVirtualTime - (room.gameStartTime ?? finishVirtualTime));
            hooks.publish(room.id, { type: 'PLAYER_FINISH_UPDATE', playerId: ghost.id, finishTime: ghost.finishTime });
        }
    }
}

export function updateRoomLogic(room: Room, hooks: GameHooks, updateCallback: (roomId: string) => void) {
    stepClock(room);

    // Cleanup check
    if (room.emptySince !== null) {
        const emptyDuration = getRealTime() - room.emptySince;
        if (emptyDuration >= MAX_IDLE_TIME) {
            if (room.timerId) clearTimeout(room.timerId);
            hooks.onRoomDeleted?.(room.id);
            return;
        }
    }

    for (const pid in room.players) {
        const p = room.players[pid];
        if (pid === 'the-stig-🏎️') continue;
        if (p.disconnectedAt && getRealTime() - p.disconnectedAt >= MAX_IDLE_TIME) {
            if (hooks.shouldDeletePlayer?.(room.id, pid) ?? true) {
                delete room.players[pid];
                hooks.publish(room.id, {
                    type: 'PLAYER_LEFT',
                    playerId: pid
                });
                checkCountdownLogic(room, hooks);
            }
        }
    }

    // Handle countdown completion
    if (room.state === 'COUNTDOWN' && room.countdownEnd && getRealTime() >= room.countdownEnd) {
        room.state = 'RUNNING';
        room.gameStartTime = room.virtualTime;
        room.countdownEnd = null;
        for (const player of Object.values(room.players)) {
            if (!player.isGhost) player.isReady = true;
            if (!player.isGhost && player.waypoints.length === 1) {
                player.waypoints[0].startTime = room.virtualTime;
                player.waypoints[0].arrivalTime = room.virtualTime;
            }
        }
        hooks.broadcastRoomState(room);

        if (room.computerDriver && !room.players['the-stig-🏎️']) {
            fetchComputerDriverRoute(room, hooks);
        }
    }

    if (room.state !== 'RUNNING') {
        scheduleNextTick(room, updateCallback);
        return;
    }

    const subscriberCount = hooks.getSubscriberCount(room.id);
    if (subscriberCount === 0) {
        if (room.playbackRate !== 0) {
            room.playbackRate = 0;
            hooks.broadcastRoomState(room);
        }
        scheduleNextTick(room, updateCallback);
        return;
    }

    calculatePlaybackRate(room, hooks);
    checkGhostFinishes(room, hooks);
    scheduleNextTick(room, updateCallback);
}

export function handleGameClose(
    rooms: Map<string, Room>,
    wsData: { roomId: string | null, playerId: string | null },
    hooks: GameHooks,
    updateRoomCallback: (roomId: string) => void
) {
    if (wsData.roomId && wsData.playerId) {
        const room = rooms.get(wsData.roomId);
        if (room) {
            markPlayerDisconnected(room, wsData.roomId, wsData.playerId, hooks, (r) => updateRoomLogic(r, hooks, updateRoomCallback));
        }
    }
}
