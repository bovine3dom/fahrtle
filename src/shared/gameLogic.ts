// src/shared/gameLogic.ts

export type Difficulty = 'Easy' | 'Normal' | 'Transport nerd';

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
};

export type Player = {
    id: string;
    color: string;
    isReady: boolean;
    waypoints: Waypoint[];
    desiredRate: number; // 1.0 or 500.0
    finishTime: number | null;
    disconnectedAt: number | null;
    viewingStopName: string | null;
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

    // Game Loop
    timerId?: ReturnType<typeof setTimeout>;

    difficulty: Difficulty;
};

export const BASE_SPEED = 5 / (60 * 60 * 1000); // 5 km/h in km/ms
const MAX_IDLE_TIME = 60000; // 1 minute cleanup check

export function haversineDist(coords1: { x: number, y: number }, coords2: { x: number, y: number }) {
    const toRad = (x: number) => x * Math.PI / 180;
    const R = 6371; // km
    const dLat = toRad(coords2.y - coords1.y);
    const dLon = toRad(coords2.x - coords1.x);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(coords1.y)) * Math.cos(toRad(coords2.y)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export function lerp(v0: number, v1: number, t: number) {
    return v0 * (1 - t) + v1 * t;
}

export function getSpawnPoint(centerLat: number, centerLng: number) {
    const spreadMeters = 50;
    const latOffset = (Math.random() - 0.5) * 2 * (spreadMeters / 111111);
    const lngOffset = (Math.random() - 0.5) * 2 * (spreadMeters / (111111 * Math.cos(centerLat * Math.PI / 180)));

    return {
        x: centerLng + lngOffset,
        y: centerLat + latOffset
    };
}

export function stepClock(room: Room) {
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

export function handleIncomingMessage(
    message: any,
    rooms: Map<string, Room>,
    wsData: { roomId: string | null, playerId: string | null },
    hooks: GameHooks,
    updateRoomCallback: (roomId: string) => void
) {
    const now = Date.now();

    const triggerUpdate = (rid: string) => {
        const r = rooms.get(rid);
        if (r) {
            updateRoomLogic(r, hooks, updateRoomCallback);
        }
    };

    // --- SYNC ---
    if (message.type === 'SYNC_REQUEST') {
        const targetRoomId = message.roomId || wsData.roomId;
        let serverTime = now;
        let rate = 1.0;

        if (targetRoomId && rooms.has(targetRoomId)) {
            const r = rooms.get(targetRoomId)!;
            const elapsed = now - r.lastRealTime;
            const vTime = r.state === 'RUNNING' ? r.virtualTime + (elapsed * r.playbackRate) : r.virtualTime;
            serverTime = vTime;
            rate = r.playbackRate;
        }

        hooks.sendToSender({
            type: 'SYNC_RESPONSE',
            clientSendTime: message.clientSendTime,
            serverTime: serverTime,
            realTime: now,
            rate: (targetRoomId && rooms.get(targetRoomId)?.state === 'RUNNING') ? rate : 0
        });
        return;
    }

    // --- JOIN ---
    if (message.type === 'JOIN_ROOM') {
        const { roomId, playerId, color } = message;

        let room = rooms.get(roomId);
        if (!room) {
            room = {
                id: roomId,
                players: {},
                state: 'JOINING',
                countdownEnd: null,
                startPos: [55.9533, -3.1883], // Edinburgh, Scotland
                finishPos: [43.7101, 7.2660], // Nice, France
                emptySince: null,
                gameStartTime: null,
                virtualTime: now,
                lastRealTime: now,
                playbackRate: 1.0,
                difficulty: 'Easy'
            };
            rooms.set(roomId, room);
        }

        room.emptySince = null;

        if (!room.players[playerId]) {
            const centerLat = room.startPos[0];
            const centerLng = room.startPos[1];
            const spawn = getSpawnPoint(centerLat, centerLng);

            room.players[playerId] = {
                id: playerId,
                color: color || ('#' + Math.floor(Math.random() * 16777215).toString(16)),
                isReady: room.state === 'RUNNING',
                waypoints: [{
                    x: spawn.x,
                    y: spawn.y,
                    startTime: 0,
                    arrivalTime: 0,
                    speedFactor: 1
                }],
                desiredRate: 1.0,
                finishTime: null,
                disconnectedAt: null,
                viewingStopName: null,
            };
        } else {
            const player = room.players[playerId];
            if (player) {
                player.disconnectedAt = null;
                if (player.desiredRate === 500.0) {
                    player.desiredRate = 1.0;
                }
            }
        }

        wsData.roomId = roomId;
        wsData.playerId = playerId;

        hooks.subscribeToRoom(roomId);

        stepClock(room);

        hooks.sendToSender({
            type: 'ROOM_STATE',
            state: room.state,
            countdownEnd: room.countdownEnd,
            gameStartTime: room.gameStartTime,
            serverTime: room.virtualTime,
            startPos: room.startPos,
            finishPos: room.finishPos,
            difficulty: room.difficulty,
            realTime: now,
            rate: room.state === 'RUNNING' ? room.playbackRate : 0,
            players: room.players
        });

        hooks.publish(roomId, {
            type: 'PLAYER_JOINED',
            player: room.players[playerId]
        });

        triggerUpdate(roomId);
    }

    // --- TOGGLE READY ---
    if (message.type === 'TOGGLE_READY') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        const player = room?.players[wsData.playerId];
        if (!room || !player) return;

        player.isReady = !player.isReady;

        hooks.publish(wsData.roomId, {
            type: 'READY_UPDATE',
            playerId: wsData.playerId,
            isReady: player.isReady
        });

        checkCountdownLogic(room, hooks);
        triggerUpdate(wsData.roomId);
    }

    if (message.type === 'UPDATE_PLAYER_COLOR') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const player = room.players[wsData.playerId];
        if (player) {
            player.color = message.color;
            hooks.publish(wsData.roomId, {
                type: 'PLAYER_COLOR_UPDATE',
                playerId: wsData.playerId,
                color: player.color
            });
        }
    }

    if (message.type === 'TOGGLE_SNOOZE') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const player = room.players[wsData.playerId];
        if (player) {
            player.desiredRate = player.desiredRate > 1.0 ? 1.0 : 500.0;

            hooks.publish(wsData.roomId, {
                type: 'PLAYER_SNOOZE_UPDATE',
                playerId: wsData.playerId,
                desiredRate: player.desiredRate
            });

            triggerUpdate(wsData.roomId);
        }
    }

    if (message.type === 'SET_GAME_BOUNDS') {
        if (!wsData.roomId) return;
        const room = rooms.get(wsData.roomId);
        if (!room || room.state !== 'JOINING') return;

        const prevStart = room.startPos;
        room.startPos = message.startPos;
        room.finishPos = message.finishPos;
        room.difficulty = message.difficulty || 'Normal';

        if (message.startTime) {
            room.virtualTime = message.startTime;
        }

        if (room.startPos) {
            const [newLat, newLng] = room.startPos;

            const posChanged = !prevStart || Math.abs(prevStart[0] - newLat) > 0.0001 || Math.abs(prevStart[1] - newLng) > 0.0001;
            const timeChanged = message.startTime !== undefined;

            if (posChanged || timeChanged) {
                for (const pid in room.players) {
                    const p = room.players[pid];
                    const spawn = getSpawnPoint(newLat, newLng);
                    p.waypoints = [{
                        x: spawn.x,
                        y: spawn.y,
                        startTime: room.virtualTime,
                        arrivalTime: room.virtualTime,
                        speedFactor: 1
                    }];

                    hooks.publish(wsData.roomId, {
                        type: 'PLAYER_WAYPOINTS_UPDATE',
                        playerId: pid,
                        waypoints: p.waypoints
                    });
                }
            }
        }
        hooks.broadcastRoomState(room);
        triggerUpdate(wsData.roomId);
    }

    if (message.type === 'SET_VIEWING_STOP') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const player = room.players[wsData.playerId];
        if (player) {
            player.viewingStopName = message.stopName;
            hooks.publish(wsData.roomId, {
                type: 'PLAYER_VIEW_UPDATE',
                playerId: wsData.playerId,
                viewingStopName: player.viewingStopName
            });
        }
    }

    // --- ADD WAYPOINT ---
    if (message.type === 'ADD_WAYPOINT') {
        if (!wsData.roomId || !wsData.playerId) return;

        const room = rooms.get(wsData.roomId);
        if (!room || room.state !== 'RUNNING') return;
        const player = room.players[wsData.playerId];
        if (!player) return;

        stepClock(room);

        const { x, y, speedFactor, arrivalTime, stopName, isWalk, route_color, route_short_name, display_name, emoji, route_departure_time } = message;
        const lastPoint = player.waypoints[player.waypoints.length - 1];

        let start = lastPoint.arrivalTime;
        if (start < room.virtualTime) {
            start = room.virtualTime;
        }

        let finalArrival = arrivalTime;
        if (finalArrival === undefined) {
            const distance = haversineDist(lastPoint, { x, y });
            const duration = distance / BASE_SPEED;
            finalArrival = start + duration;
        }

        player.viewingStopName = null;

        const newWaypoint: Waypoint = {
            x, y,
            startTime: start,
            arrivalTime: finalArrival,
            speedFactor: speedFactor,
            stopName: stopName || undefined,
            isWalk: isWalk || false,
            route_color,
            route_short_name,
            display_name,
            emoji: isWalk ? '🐾' : emoji,
            route_departure_time
        };

        player.waypoints.push(newWaypoint);

        hooks.publish(wsData.roomId, {
            type: 'WAYPOINT_ADDED',
            playerId: wsData.playerId,
            waypoint: newWaypoint
        });

        triggerUpdate(wsData.roomId);
    }

    // --- CANCEL NAVIGATION ---
    if (message.type === 'CANCEL_NAVIGATION') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const player = room.players[wsData.playerId];
        if (!player) return;

        stepClock(room);
        const vTime = room.virtualTime;

        const nextWpIndex = player.waypoints.findIndex(wp => wp.arrivalTime > vTime);

        if (nextWpIndex !== -1 && nextWpIndex < player.waypoints.length - 1) {
            player.waypoints = player.waypoints.slice(0, nextWpIndex + 1);

            hooks.publish(wsData.roomId, {
                type: 'PLAYER_WAYPOINTS_UPDATE',
                playerId: wsData.playerId,
                waypoints: player.waypoints
            });
            triggerUpdate(wsData.roomId);
        }
    }

    if (message.type === 'STOP_IMMEDIATELY') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room) return;
        const player = room.players[wsData.playerId];
        if (!player) return;

        stepClock(room);
        const vTime = room.virtualTime;

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
                currentPos.x = nextWp.x;
                currentPos.y = nextWp.y;
            } else {
                currentPos.x = prevWp.x;
                currentPos.y = prevWp.y;
            }
        } else {
            const last = player.waypoints[player.waypoints.length - 1];
            currentPos.x = last.x;
            currentPos.y = last.y;
        }

         if (nextWpIndex !== -1) {
            const nextWp = player.waypoints[nextWpIndex];
            const prevWp = player.waypoints[nextWpIndex - 1] || player.waypoints[0];
            const segStartTime = Math.max(prevWp.arrivalTime, nextWp.startTime);

            player.waypoints = [
                ...player.waypoints.slice(0, nextWpIndex),
                {
                    x: currentPos.x,
                    y: currentPos.y,
                    startTime: segStartTime,
                    arrivalTime: vTime,
                    speedFactor: 1,
                    stopName: 'Stopped',
                }
            ];
        } else {
            const last = player.waypoints[player.waypoints.length - 1];
            if (last) {
                last.stopName = 'Stopped';
                last.arrivalTime = Math.min(last.arrivalTime, vTime);
            }
        }

        hooks.publish(wsData.roomId, {
            type: 'PLAYER_WAYPOINTS_UPDATE',
            playerId: wsData.playerId,
            waypoints: player.waypoints
        });
        triggerUpdate(wsData.roomId);
    }

    if (message.type === 'PLAYER_FINISHED') {
        if (!wsData.roomId || !wsData.playerId) return;
        const room = rooms.get(wsData.roomId);
        if (!room || room.state !== 'RUNNING') return;

        const player = room.players[wsData.playerId];
        if (!player || player.finishTime) return;
        player.finishTime = message.finishTime;

        hooks.publish(wsData.roomId, {
            type: 'PLAYER_FINISH_UPDATE',
            playerId: wsData.playerId,
            finishTime: player.finishTime
        });
    }
}

export function checkCountdownLogic(room: Room, hooks: GameHooks) {
    const pCount = Object.keys(room.players).length;
    const readyCount = Object.values(room.players).filter(p => p.isReady).length;
    const allReady = pCount > 0 && readyCount === pCount;

    if (room.state === 'JOINING' && allReady) {
        room.state = 'COUNTDOWN';
        room.countdownEnd = Date.now() + 5000;
        hooks.broadcastRoomState(room);
    } else if (room.state === 'COUNTDOWN' && !allReady) {
        room.state = 'JOINING';
        room.countdownEnd = null;
        hooks.broadcastRoomState(room);
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

    let minSpeed = 1.0;
    const activeFactors: number[] = [];
    const vTime = room.virtualTime;

    for (const pid in room.players) {
        const p = room.players[pid];
        let currentFactor = p.desiredRate || 1.0;

        for (const wp of p.waypoints) {
            if (vTime >= wp.startTime && vTime < wp.arrivalTime) {
                currentFactor = Math.max(wp.speedFactor, p.desiredRate || 1.0);
                break;
            }
        }
        activeFactors.push(currentFactor);
    }

    if (activeFactors.length > 0) {
        minSpeed = Math.max(1.0, Math.min(...activeFactors));
    } else {
        minSpeed = 1.0;
    }

    if (Math.abs(room.playbackRate - minSpeed) > 0.01) {
        room.playbackRate = minSpeed;
        hooks.publish(room.id, {
            type: 'CLOCK_UPDATE',
            serverTime: room.virtualTime,
            realTime: Date.now(),
            rate: room.playbackRate
        });
    }

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
                    player.desiredRate = 500.0;
                    hooks.publish(wsData.roomId, {
                        type: 'PLAYER_SNOOZE_UPDATE',
                        playerId: wsData.playerId,
                        desiredRate: player.desiredRate
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
