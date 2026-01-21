import type { Player, Difficulty } from '../store';
import { getDailyRaceIndex } from './daily';
import { formatRowTime, sensibleNumber } from './format';
import { findClosestCity, haversineDist } from './geo';
import { formatDuration } from './time';

const getTravelSummaryObj = (player: Player) => {
    const waypoints = player.waypoints.map((wp) => {
        return {
            route_departure_time: wp.route_departure_time,
            route_short_name: wp.route_short_name,
            display_name: wp.display_name,
            emoji: wp.emoji,
        }
    })
    // deduplicate waypoints
    const uniqueWaypoints = waypoints.filter((wp, index) => {
        return waypoints.findIndex(w => w.route_departure_time === wp.route_departure_time && w.route_short_name === wp.route_short_name && w.display_name === wp.display_name && w.emoji === wp.emoji) === index;
    })
    return uniqueWaypoints;
}

import { getTimeZone } from '../timezone';

/* convert object to a human readable string for sharing on socials */
export const getTravelSummary = (player: Player, gameBounds: { start: [number, number] | null, finish: [number, number] | null, time?: number, difficulty?: Difficulty }, stealth = false) => {
    const waypoints = getTravelSummaryObj(player).filter(wp => wp.route_departure_time);
    let travel = stealth ? waypoints.map((wp) => { if (wp.emoji == "🐾") return; return `${wp.emoji}`; }).filter(s => s).join('') : waypoints.map((wp) => {
        if (wp.emoji == "🐾") return;
        return `${wp.emoji} ${wp.route_short_name} ${formatRowTime(wp.route_departure_time || '')} ${wp.display_name}`;
    }).filter(s => s).join('\n');

    // Fallback if no specific finish city can be determined from the bounds
    const finishCity = gameBounds.finish ? findClosestCity({ latitude: gameBounds.finish[0], longitude: gameBounds.finish[1] }) : "";
    const startCity = gameBounds.start ? findClosestCity({ latitude: gameBounds.start[0], longitude: gameBounds.start[1] }) : "";
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


    const dayPrefix = isDaily ? ` daily #${getDailyRaceIndex()}!` : '';

    travel = `I just played fahrtle${dayPrefix}\n${startCity} ➡️ ${finishCity} (${sensibleNumber(haversineDist(gameBounds.start, gameBounds.finish) || 0)} km)\n${travel}`;
    return `${player.finishTime ? `${travel}\n🎉 Finished in ${formatDuration(player.finishTime)}!` : travel}\nCan you beat me? ${url.toString()}`;
}
