import type { Player, Difficulty, Waypoint } from '../store';
import { getDailyRaceIndex } from './daily';
import { formatRowTime, sensibleNumber } from './format';
import { haversineDist } from './geo';
import { createClosestCity, cityDbPromise } from './tiny-cities';
import { formatDuration } from './time';

type SummaryEntry = {
    type: 'transport' | 'walk' | 'wait';
    emoji: string;
    duration?: number;
    distance?: number;
    route_departure_time?: string;
    route_short_name?: string;
    display_name?: string;
    x?: number;
    y?: number;
};

const getTravelSummaryObj = (player: Player): SummaryEntry[] => {
    const summary: SummaryEntry[] = [];
    const waypoints = player.waypoints;

    if (waypoints.length === 0) return [];

    let currentWalkDist = 0;
    let currentWalkStart: number | null = null;
    let currentWalkEnd: number | null = null;

    const pushWait = (duration: number, wp: Waypoint) => {
        if (duration <= 0) return;
        const last = summary[summary.length - 1];
        if (last && last.type === 'wait') {
            last.duration! += duration;
        } else {
            summary.push({
                type: 'wait',
                emoji: '⏳',
                duration: duration,
                x: wp.x,
                y: wp.y,
            });
        }
    };

    const pushWalk = (wp: Waypoint) => {
        if (currentWalkStart !== null) {
            const duration = currentWalkEnd! - currentWalkStart;
            if (currentWalkDist < 1) { // call <1km walks waits
                (duration > 30 * 60 * 1000) && pushWait(duration, wp); // only count >30 min waits
            } else {
                summary.push({
                    type: 'walk',
                    emoji: '🐾',
                    duration: duration,
                    distance: currentWalkDist,
                    x: wp.x,
                    y: wp.y,
                });
            }
            currentWalkStart = null;
            currentWalkEnd = null;
            currentWalkDist = 0;
        }
    };

    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        const prevWp = i > 0 ? waypoints[i - 1] : null;

        if (wp.isWalk) {
            if (currentWalkStart === null) {
                currentWalkStart = wp.startTime;
            }
            currentWalkEnd = wp.arrivalTime;
            if (prevWp) {
                currentWalkDist += haversineDist({ lat: prevWp.y, lon: prevWp.x }, { lat: wp.y, lon: wp.x }) || 0;
            }
        } else {
            pushWalk(prevWp || wp);

            if (wp.route_departure_time) {
                const lastEntry = summary[summary.length - 1];
                if (lastEntry?.type !== 'transport' || lastEntry.route_departure_time !== wp.route_departure_time || lastEntry.route_short_name !== wp.route_short_name) {
                    summary.push({
                        type: 'transport',
                        route_departure_time: wp.route_departure_time,
                        route_short_name: wp.route_short_name,
                        display_name: wp.display_name,
                        emoji: wp.emoji || '👽',
                    });
                }
            }
        }
    }

    pushWalk(waypoints[waypoints.length - 1]);
    return summary;
}

import { getTimeZone } from '../timezone';

/* convert object to a human readable string for sharing on socials */
export const getTravelSummary = async (player: Player, gameBounds: { start: [number, number] | null, finish: [number, number] | null, time?: number, difficulty?: Difficulty }, stealth = false, targetTime?: number) => {
    await cityDbPromise;
    const summaryEntries = getTravelSummaryObj(player);
    let travel = stealth ? summaryEntries.map((wp) => { return `${wp.emoji}`; }).join('') : summaryEntries.map((wp) => {
        if (wp.type === 'walk') {
            return `${wp.emoji} Walked ${sensibleNumber(wp.distance || 0)} km (${formatDuration(wp.duration || 0)}) to ${createClosestCity(() => ({ lat: wp.y || 0, lon: wp.x || 0 }))()}`;
        } else if (wp.type === 'wait') {
            return `${wp.emoji} Waited ${formatDuration(wp.duration || 0)} in ${createClosestCity(() => ({ lat: wp.y || 0, lon: wp.x || 0 }))()}`;
        } else {
            return `${wp.emoji} ${formatRowTime(wp.route_departure_time || '')} ${wp.route_short_name} ${wp.display_name}`;
        }
    }).join('\n');

    const [finishCity, startCity] = [
        gameBounds.finish ? createClosestCity(() => ({ lat: gameBounds.finish![0], lon: gameBounds.finish![1] })) : (() => ""),
        gameBounds.start ? createClosestCity(() => ({ lat: gameBounds.start![0], lon: gameBounds.start![1] })) : (() => "")
    ];
    const isDaily = typeof localStorage !== 'undefined' && localStorage.getItem('fahrtle_daily') === 'true';

    const url = new URL(window.location.origin + window.location.pathname);
    if (!isDaily) {
        if (gameBounds.start) {
            url.searchParams.set('s', `${gameBounds.start[0].toFixed(4)},${gameBounds.start[1].toFixed(4)}`);
        }
        if (gameBounds.finish) {
            url.searchParams.set('f', `${gameBounds.finish[0].toFixed(4)},${gameBounds.finish[1].toFixed(4)}`);
        }
        if (gameBounds.time && gameBounds.start) {
            const tz = getTimeZone(gameBounds.start[0], gameBounds.start[1]);
            const timeStr = new Intl.DateTimeFormat('en-GB', {

                timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
            }).format(new Date(gameBounds.time));
            url.searchParams.set('t', timeStr);
        }
    } else {
        url.searchParams.set('daily', "1");
    }

    if (gameBounds.difficulty) {
        url.searchParams.set('d', gameBounds.difficulty);
    }


    const dayPrefix = isDaily ? ` daily #${await getDailyRaceIndex()}!` : '';

    travel = `I just played #fahrtle${dayPrefix}\n${startCity()} ➡️ ${finishCity()} (${sensibleNumber(haversineDist(gameBounds.start ? { lat: gameBounds.start[0], lon: gameBounds.start[1] } : null, gameBounds.finish ? { lat: gameBounds.finish[0], lon: gameBounds.finish[1] } : null) || 0)} km)\n${travel}`;
    if (player.finishTime) {
        if (targetTime) {
            const diff = player.finishTime - targetTime;
            const sign = diff <= 0 ? ['🏁', 'faster'] : ['🐢', 'slower'];
            travel += `\n${sign[0]} ${formatDuration(Math.abs(diff))} ${sign[1]} than driving`;
        }
        travel += `\n🎉 Finished in ${formatDuration(player.finishTime)}!`;
    }
    return `${travel}\nCan you beat me? ${url.toString()}`;
}
