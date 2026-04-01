// src/shared/gameLogic.ts
import simplify from 'simplify-js';
import { haversineDist } from '../utils/geo';
import { generatePilotName } from '../names';
export const CURRENT_LEAGUE = "20260218";

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

function lerp(v0: number, v1: number, t: number) {
    return v0 * (1 - t) + v1 * t;
}

function getSpawnPoint(centerLat: number, centerLng: number) {
    const spreadMeters = 50;
    const latOffset = (Math.random() - 0.5) * 2 * (spreadMeters / 111111);
    const lngOffset = (Math.random() - 0.5) * 2 * (spreadMeters / (111111 * Math.cos(centerLat * Math.PI / 180)));

    return {
        x: centerLng + lngOffset,
        y: centerLat + latOffset
    };
}

function stepClock(room: Room) {
    const now = Date.now();
    const elapsedReal = now - room.lastRealTime;
    if (room.state === 'RUNNING') {
        room.virtualTime += elapsedReal * room.playbackRate;
    }
    room.lastRealTime = now;
}

export interface GameHooks {
    broadcastRoomState: (room: Room) => void;
    publish: (roomId: string, message: any) => void;
    getSubscriberCount: (roomId: string) => number;
    onRoomDeleted?: (roomId: string) => void;
    sendToSender: (message: any) => void;
    subscribeToRoom: (roomId: string) => void;
    shouldDeletePlayer?: (roomId: string, playerId: string) => boolean;
}

function scheduleNextTick(room: Room, updateCallback: (roomId: string) => void) {
    if (room.timerId) {
        clearTimeout(room.timerId);
        room.timerId = undefined;
    }

    const now = Date.now();
    let delay = MAX_IDLE_TIME;

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

    try {
        const body = JSON.stringify({
            coordinates: [[room.startPos[1], room.startPos[0]], [room.finishPos[1], room.finishPos[0]]]
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

        const coords = feature.geometry.coordinates;
        const steps = feature.properties.segments[0].steps;
        const startTime = room.gameStartTime || room.virtualTime;

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
    const player = room.players[wsData.playerId];
    if (!player) return null;
    return { room, player };
}

function handleSyncRequest(message: any, rooms: Map<string, Room>, hooks: GameHooks) {
    const now = Date.now();
    const targetRoomId = message.roomId;
    let serverTime = now;
    let rate = 1.0;

    if (targetRoomId && rooms.has(targetRoomId)) {
        const r = rooms.get(targetRoomId)!;
        const elapsed = now - r.lastRealTime;
        serverTime = r.state === 'RUNNING' ? r.virtualTime + (elapsed * r.playbackRate) : r.virtualTime;
        rate = r.playbackRate;
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
    const now = Date.now();
    const { roomId, playerId, color } = message;

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

    room.emptySince = null;

    if (!room.players[playerId]) {
        const spawn = getSpawnPoint(room.startPos[0], room.startPos[1]);
        room.players[playerId] = {
            id: playerId,
            color: color || ('#' + Math.floor(Math.random() * 16777215).toString(16)),
            isReady: room.state === 'RUNNING',
            waypoints: [{ x: spawn.x, y: spawn.y, startTime: 0, arrivalTime: 0, speedFactor: 1 }],
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

    wsData.roomId = roomId;
    wsData.playerId = playerId;

    hooks.subscribeToRoom(roomId);
    stepClock(room);

    hooks.sendToSender({
        type: 'ROOM_STATE', state: room.state, countdownEnd: room.countdownEnd,
        gameStartTime: room.gameStartTime, serverTime: room.virtualTime,
        ...boundsToWire(getRoomBounds(room)), isRerun: room.isRerun,
        realTime: now, rate: room.state === 'RUNNING' ? room.playbackRate : 0,
        players: room.players
    });

    hooks.publish(roomId, { type: 'PLAYER_JOINED', player: room.players[playerId] });
    triggerUpdate(roomId);
}

function handleRaceAgain(
    message: any,
    wsData: { roomId: string | null, playerId: string | null },
    result: { room: Room; player: Player },
    hooks: GameHooks,
    triggerUpdate: (rid: string) => void
) {
    const { room, player } = result;
    const ghostId = `👻-${generatePilotName()}`;
    const hue = Math.floor(Math.random() * 360);
    const ghost: Player = {
        id: ghostId, color: `hsl(${hue}, 30%, 50%)`, isReady: true,
        waypoints: message.waypoints, desiredRate: 1e9, forceRealtime: false,
        finishTime: null, disconnectedAt: null, viewingStopName: null, isGhost: true
    };

    room.players[ghostId] = ghost;

    const spawn = getSpawnPoint(room.startPos[0], room.startPos[1]);
    player.waypoints = [{ x: spawn.x, y: spawn.y, startTime: room.initialStartTime, arrivalTime: room.initialStartTime, speedFactor: 1 }];
    player.isReady = false;
    player.finishTime = null;

    hooks.publish(wsData.roomId!, { type: 'PLAYER_FINISH_UPDATE', playerId: wsData.playerId, finishTime: null });
    room.state = 'JOINING';
    room.virtualTime = room.initialStartTime;
    room.gameStartTime = null;
    room.isRerun = true;

    hooks.publish(wsData.roomId!, { type: 'PLAYER_JOINED', playerId: ghostId, player: ghost });
    hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: wsData.playerId, waypoints: player.waypoints });
    hooks.publish(wsData.roomId!, { type: 'READY_UPDATE', playerId: wsData.playerId, isReady: false });
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

    const prevStart = room.startPos;
    room.startPos = message.startPos;
    room.finishPos = message.finishPos;
    room.difficulty = message.difficulty || 'Normal';
    room.computerDriver = !!message.computerDriver;
    room.ghosts = !!message.ghosts;
    room.league = message.league;

    if (message.startTime) {
        room.virtualTime = message.startTime;
        room.initialStartTime = message.startTime;
    }

    if (room.startPos) {
        const [newLat, newLng] = room.startPos;
        const posChanged = !prevStart || Math.abs(prevStart[0] - newLat) > 0.0001 || Math.abs(prevStart[1] - newLng) > 0.0001;
        const timeChanged = message.startTime !== undefined;

        if (posChanged || timeChanged) {
            for (const pid of Object.keys(room.players)) {
                if (room.players[pid].isGhost) { delete room.players[pid]; continue; }
                const p = room.players[pid];
                const spawn = getSpawnPoint(newLat, newLng);
                p.waypoints = [{ x: spawn.x, y: spawn.y, startTime: room.virtualTime, arrivalTime: room.virtualTime, speedFactor: 1 }];
                hooks.publish(wsData.roomId!, { type: 'PLAYER_WAYPOINTS_UPDATE', playerId: pid, waypoints: p.waypoints });
            }
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
    const triggerUpdate = (rid: string) => {
        const r = rooms.get(rid);
        if (r) updateRoomLogic(r, hooks, updateRoomCallback);
    };

    if (message.type === 'SYNC_REQUEST') { handleSyncRequest(message, rooms, hooks); return; }
    if (message.type === 'JOIN_ROOM') { handleJoinRoom(message, rooms, wsData, hooks, triggerUpdate); return; }

    if (message.type === 'TOGGLE_READY') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        r.player.isReady = !r.player.isReady;
        hooks.publish(wsData.roomId!, { type: 'READY_UPDATE', playerId: wsData.playerId, isReady: r.player.isReady });
        checkCountdownLogic(r.room, hooks);
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'RACE_AGAIN') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        handleRaceAgain(message, wsData, r, hooks, triggerUpdate);
        return;
    }

    if (message.type === 'ADD_GHOSTS') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const { ghosts } = message;
        if (!Array.isArray(ghosts)) return;
        for (const ghostData of ghosts) {
            const { playerName, waypoints, color } = ghostData;
            const ghostId = `👻-${playerName}`;
            const ghost: Player = {
                id: ghostId, color: color || `hsl(${Math.floor(Math.random() * 360)}, 30%, 50%)`,
                isReady: true, waypoints, desiredRate: 1e9, forceRealtime: false,
                finishTime: null, disconnectedAt: null, viewingStopName: null, isGhost: true
            };
            room.players[ghostId] = ghost;
            hooks.publish(wsData.roomId, { type: 'PLAYER_JOINED', playerId: ghostId, player: ghost });
        }
        hooks.broadcastRoomState(room);
        return;
    }

    if (message.type === 'UPDATE_PLAYER_COLOR') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        r.player.color = message.color;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_COLOR_UPDATE', playerId: wsData.playerId, color: r.player.color });
        return;
    }

    if (message.type === 'TOGGLE_SNOOZE') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
        r.player.forceRealtime = false;
        r.player.desiredRate = r.player.desiredRate > 1.0 ? 1.0 : 500.0;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_SNOOZE_UPDATE', playerId: wsData.playerId, desiredRate: r.player.desiredRate, forceRealtime: r.player.forceRealtime });
        triggerUpdate(wsData.roomId!);
        return;
    }

    if (message.type === 'FORCE_REALTIME') {
        const r = requireRoomAndPlayer(wsData, rooms);
        if (!r) return;
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
        r.player.viewingStopName = message.stopName;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_VIEW_UPDATE', playerId: wsData.playerId, viewingStopName: r.player.viewingStopName });
        return;
    }

    if (message.type === 'ADD_WAYPOINTS_BATCH') {
        const r = requireRoomAndPlayer(wsData, rooms, { requireRunning: true });
        if (!r) return;
        stepClock(r.room);
        r.player.viewingStopName = null;
        const { waypoints } = message;
        if (!Array.isArray(waypoints) || waypoints.length === 0) return;
        for (const wp of waypoints) {
            const lastPoint = r.player.waypoints[r.player.waypoints.length - 1];
            let start = Math.max(lastPoint.arrivalTime, r.room.virtualTime);
            let finalArrival = wp.arrivalTime;
            if (finalArrival === undefined) {
                const distance = haversineDist({ lat: lastPoint.y, lon: lastPoint.x }, { lat: wp.y, lon: wp.x }) || 0;
                finalArrival = start + distance / BASE_SPEED;
            }
            r.player.waypoints.push({
                x: wp.x, y: wp.y, startTime: start, arrivalTime: finalArrival,
                speedFactor: wp.speedFactor, stopName: wp.stopName,
                isWalk: wp.isWalk || false, isWait: wp.isWait || false, isInterstop: wp.isInterstop || false,
                route_color: wp.route_color, route_short_name: wp.route_short_name,
                display_name: wp.display_name, emoji: wp.isWalk ? '🐾' : (wp.isWait ? '⏳' : wp.emoji),
                route_departure_time: wp.route_departure_time, timeStr: wp.timeStr
            });
        }
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
        let start = Math.max(lastPoint.arrivalTime, r.room.virtualTime);
        let finalArrival = arrivalTime;
        if (finalArrival === undefined) {
            const distance = haversineDist({ lat: lastPoint.y, lon: lastPoint.x }, { lat: y, lon: x }) || 0;
            finalArrival = start + distance / BASE_SPEED;
        }
        r.player.viewingStopName = null;
        const newWaypoint: Waypoint = {
            x, y, startTime: start, arrivalTime: finalArrival, speedFactor,
            stopName: stopName || undefined, isWalk: isWalk || false, isWait: isWait || false, isInterstop: isInterstop || false,
            route_color, route_short_name, display_name, emoji: isWalk ? '🐾' : (isWait ? '⏳' : emoji),
            route_departure_time, timeStr
        };
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
        if (!r || r.player.finishTime) return;
        r.player.finishTime = message.finishTime;
        hooks.publish(wsData.roomId!, { type: 'PLAYER_FINISH_UPDATE', playerId: wsData.playerId, finishTime: r.player.finishTime });
        return;
    }

    if (message.type === 'PLAYER_KICK') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const { playerId } = message;
        if (!playerId || !room.players[playerId]) return;
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
        if (typeof lat !== 'number' || typeof lon !== 'number') return;
        hooks.publish(wsData.roomId!, { type: 'RECV_PING', playerId: wsData.playerId, lat, lon, timestamp: Date.now() });
    }
}

function checkCountdownLogic(room: Room, hooks: GameHooks) {
    const pCount = Object.keys(room.players).filter(pid => !room.players[pid].isGhost).length;
    const readyCount = Object.values(room.players)
        .filter(p => !p.isGhost && p.isReady)
        .length;
    const allReady = pCount > 0 && readyCount === pCount;

    if (room.state === 'JOINING' && allReady) {
        room.state = 'COUNTDOWN';
        room.countdownEnd = Date.now() + COUNTDOWN_DURATION;
        hooks.broadcastRoomState(room);
    } else if (room.state === 'COUNTDOWN' && !allReady) {
        room.state = 'JOINING';
        room.countdownEnd = null;
        hooks.broadcastRoomState(room);
    }
}

function calculatePlaybackRate(room: Room, hooks: GameHooks) {
    const activeFactors: number[] = [];
    for (const pid in room.players) {
        const p = room.players[pid];
        let currentFactor = p.forceRealtime ? 1.0 : (p.desiredRate || 1.0);
        for (const wp of p.waypoints) {
            if (room.virtualTime >= wp.startTime && room.virtualTime < wp.arrivalTime) {
                currentFactor = p.forceRealtime ? 1.0 : Math.max(wp.speedFactor, p.desiredRate || 1.0);
                break;
            }
        }
        activeFactors.push(currentFactor);
    }
    const newRate = activeFactors.length > 0 ? Math.max(1.0, Math.min(...activeFactors)) : 1.0;
    if (Math.abs(room.playbackRate - newRate) > 0.01) {
        room.playbackRate = newRate;
        hooks.publish(room.id, { type: 'CLOCK_UPDATE', serverTime: room.virtualTime, realTime: Date.now(), rate: room.playbackRate });
    }
}

function checkGhostFinishes(room: Room, hooks: GameHooks) {
    const ghosts = Object.values(room.players).filter(p => p.isGhost);
    const playerStart = Object.values(room.players).filter(p => !p.isGhost)[0]?.waypoints[0]?.startTime || 0;
    for (const ghost of ghosts) {
        const offset = playerStart - ghost.waypoints[0].startTime;
        if (ghost && !ghost.finishTime && ghost.waypoints.length > 0) {
            const lastWp = ghost.waypoints[ghost.waypoints.length - 1];
            if (room.virtualTime >= (offset + lastWp.arrivalTime)) {
                ghost.finishTime = room.virtualTime - (room.gameStartTime || room.virtualTime);
                hooks.publish(room.id, { type: 'PLAYER_FINISH_UPDATE', playerId: ghost.id, finishTime: ghost.finishTime });
            }
        }
    }
}

export function updateRoomLogic(room: Room, hooks: GameHooks, updateCallback: (roomId: string) => void) {
    stepClock(room);

    // Cleanup check
    if (room.emptySince !== null) {
        const emptyDuration = Date.now() - room.emptySince;
        if (emptyDuration > MAX_IDLE_TIME) {
            if (room.timerId) clearTimeout(room.timerId);
            hooks.onRoomDeleted?.(room.id);
            return;
        }
    }

    for (const pid in room.players) {
        const p = room.players[pid];
        if (pid === 'the-stig-🏎️') continue;
        if (p.disconnectedAt && Date.now() - p.disconnectedAt > MAX_IDLE_TIME) {
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
    if (room.state === 'COUNTDOWN' && room.countdownEnd && Date.now() >= room.countdownEnd) {
        room.state = 'RUNNING';
        room.gameStartTime = room.virtualTime;
        room.countdownEnd = null;
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
            const player = room.players[wsData.playerId];
            if (player) {
                player.disconnectedAt = Date.now();

                const roomConnections = hooks.getSubscriberCount(wsData.roomId);
                if (roomConnections > 0) {
                    player.forceRealtime = false;
                    player.desiredRate = 500.0;
                    hooks.publish(wsData.roomId, {
                        type: 'PLAYER_SNOOZE_UPDATE',
                        playerId: wsData.playerId,
                        desiredRate: player.desiredRate,
                        forceRealtime: player.forceRealtime
                    });

                    updateRoomLogic(room, hooks, updateRoomCallback);
                } else {
                    room.emptySince = Date.now();
                    room.playbackRate = 0;
                    updateRoomLogic(room, hooks, updateRoomCallback);
                }
            }
        }
    }
}
