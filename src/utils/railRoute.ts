import { decode } from "@googlemaps/polyline-codec";
import { haversineDist } from "./geo";
import simplify from 'simplify-js';

/**
 * Augments a list of waypoints (stops) with a detailed rail path from signal.eu.org.
 * Interpolates timing based on the original stop times.
 */
function processRailLeg(leg: any, startWp: any, endWp: any, isLastLeg: boolean): any[] {
    const legCoords: [number, number][] = [];
    for (const step of leg.steps) {
        if (step.geometry) {
            const decoded = decode(step.geometry);
            for (const [lat, lng] of decoded) legCoords.push([lng, lat]);
        }
    }

    const uniqueCoords = legCoords.filter((c, idx, self) =>
        idx === 0 || (c[0] !== self[idx - 1][0] || c[1] !== self[idx - 1][1])
    );

    const simplifiedPoints = simplify(
        uniqueCoords.map(c => ({ x: c[0], y: c[1] })), 0.0025, true
    ).map(p => [p.x, p.y] as [number, number]);

    if (simplifiedPoints.length === 0) return [{ ...startWp }];

    const pointDistances: number[] = [0];
    let totalLegDist = 0;
    for (let j = 1; j < simplifiedPoints.length; j++) {
        totalLegDist += haversineDist({ lon: simplifiedPoints[j - 1][0], lat: simplifiedPoints[j - 1][1] }, { lon: simplifiedPoints[j][0], lat: simplifiedPoints[j][1] }) || 0;
        pointDistances.push(totalLegDist);
    }

    const straightLineDist = haversineDist({ lon: startWp.lng, lat: startWp.lat }, { lon: endWp.lng, lat: endWp.lat }) || 0;
    if (straightLineDist > 0 && totalLegDist > straightLineDist * 3) {
        console.warn(`[railRoute] Leg route too long (${totalLegDist.toFixed(1)}km vs ${straightLineDist.toFixed(1)}km straight), falling back to direct line`);
        const fallback: any[] = [{ ...startWp, isInterstop: false }];
        if (isLastLeg) fallback.push({ ...endWp, isInterstop: false });
        return fallback;
    }

    const timeDiff = endWp.time - startWp.time;
    const points: any[] = [];

    for (let j = 0; j < simplifiedPoints.length; j++) {
        if (!isLastLeg && j === simplifiedPoints.length - 1) continue;
        const distRatio = totalLegDist === 0 ? 0 : pointDistances[j] / totalLegDist;
        const isRealStop = j === 0 || (isLastLeg && j === simplifiedPoints.length - 1);
        points.push({
            ...startWp,
            lng: simplifiedPoints[j][0], lat: simplifiedPoints[j][1],
            time: startWp.time + distRatio * timeDiff,
            stopName: isRealStop ? (j === 0 ? startWp.stopName : endWp.stopName) : undefined,
            timeStr: isRealStop ? (j === 0 ? startWp.timeStr : endWp.timeStr) : undefined,
            isInterstop: !isRealStop,
            isWalk: (j === 0) ? startWp.isWalk : false,
        });
    }
    return points;
}

export async function augmentWithRailRoute(points: any[]) {
    if (points.length < 2) return points;

    const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://signal.eu.org/osm/eu/route/v1/train/${coords}?overview=full&steps=true`;

    try {
        const response = await fetch(url);
        if (!response.ok) return points;
        const data = await response.json();
        if (!data.routes || data.routes.length === 0) return points;

        const route = data.routes[0];
        const augmentedPoints: any[] = [];

        for (let i = 0; i < route.legs.length; i++) {
            const legPoints = processRailLeg(route.legs[i], points[i], points[i + 1], i === route.legs.length - 1);
            augmentedPoints.push(...legPoints);
        }

        return augmentedPoints;
    } catch (err) {
        console.error(`[signal.eu.org routing] error:`, err);
        return points;
    }
}
