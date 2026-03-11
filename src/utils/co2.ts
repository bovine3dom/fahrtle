import { routeTypeEmissions, emojiToRouteType } from '../getRouteEmoji';
import { haversineDist } from './geo';
import type { Waypoint } from '../store';
export const calculateCO2Emissions = (waypoints: Waypoint[]): number => {
    let totalCO2 = 0;

    for (let i = 1; i < waypoints.length; i++) {
        const wp = waypoints[i];
        const prevWp = waypoints[i - 1];

        const dist = haversineDist({ lat: prevWp.y, lon: prevWp.x }, { lat: wp.y, lon: wp.x });
        if (!dist || dist === 0) continue;

        const emoji = wp.isWalk ? '🐾' : (wp.emoji || '👽');
        const routeType = emojiToRouteType[emoji] ?? 'misc';
        const emissionFactor = routeTypeEmissions[routeType] ?? routeTypeEmissions.misc;

        totalCO2 += dist * emissionFactor;
    }

    return totalCO2 / 1000;
};
