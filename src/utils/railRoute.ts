import { decode } from "@googlemaps/polyline-codec";
import { haversineDist } from "./geo";
import simplify from 'simplify-js';

/**
 * Augments a list of waypoints (stops) with a detailed rail path from signal.eu.org.
 * Interpolates timing based on the original stop times.
 */
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
            const leg = route.legs[i];
            const startWp = points[i];
            const endWp = points[i + 1];

            const legCoords: [number, number][] = [];
            for (const step of leg.steps) {
                if (step.geometry) {
                    const decoded = decode(step.geometry);
                    for (const [lat, lng] of decoded) {
                        legCoords.push([lng, lat]);
                    }
                }
            }

            const uniqueCoords = legCoords.filter((c, idx, self) =>
                idx === 0 || (c[0] !== self[idx - 1][0] || c[1] !== self[idx - 1][1])
            );

            const simplifiedPoints = simplify(
                uniqueCoords.map(c => ({ x: c[0], y: c[1] })),
                0.0025, // units in degrees
                true
            ).map(p => [p.x, p.y] as [number, number]);

            if (simplifiedPoints.length === 0) {
                augmentedPoints.push(startWp);
                continue;
            }

            const pointDistances: number[] = [0];
            let totalLegDist = 0;
            for (let j = 1; j < simplifiedPoints.length; j++) {
                const d = haversineDist(
                    { lon: simplifiedPoints[j - 1][0], lat: simplifiedPoints[j - 1][1] },
                    { lon: simplifiedPoints[j][0], lat: simplifiedPoints[j][1] }
                ) || 0;
                totalLegDist += d;
                pointDistances.push(totalLegDist);
            }

            const timeDiff = endWp.time - startWp.time;

            for (let j = 0; j < simplifiedPoints.length; j++) {
                if (i < route.legs.length - 1 && j === simplifiedPoints.length - 1) {
                    continue;
                }

                const distRatio = totalLegDist === 0 ? 0 : pointDistances[j] / totalLegDist;
                const pointTime = startWp.time + distRatio * timeDiff;
                const isRealStop = j === 0 || (i === route.legs.length - 1 && j === simplifiedPoints.length - 1);

                augmentedPoints.push({
                    ...startWp,
                    lng: simplifiedPoints[j][0],
                    lat: simplifiedPoints[j][1],
                    time: pointTime,
                    stopName: isRealStop ? (j === 0 ? startWp.stopName : endWp.stopName) : undefined,
                    timeStr: isRealStop ? (j === 0 ? startWp.timeStr : endWp.timeStr) : undefined,
                    isInterstop: !isRealStop,
                    isWalk: (i === 0 && j === 0) ? startWp.isWalk : false,
                });
            }
        }

        return augmentedPoints;
    } catch (err) {
        console.error(`[signal.eu.org routing] error:`, err);
        return points;
    }
}
