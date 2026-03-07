import { decode } from "@googlemaps/polyline-codec";
import { haversineDist } from "./geo";
import simplify from 'simplify-js';

export async function augmentWithShape(stops: any[], shapePoints: any[]) {
    if (stops.length === 0) return stops;
    if (shapePoints.length < 2) return stops;
    // todo: if fewer than 1.5x shape, route with signal

    // dedup
    const cleanShape = [shapePoints[0]];
    for (let i = 1; i < shapePoints.length; i++) {
        if (shapePoints[i].lat !== shapePoints[i-1].lat || shapePoints[i].lon !== shapePoints[i-1].lon) {
            cleanShape.push(shapePoints[i]);
        }
    }

    // locally euclidean
    const refLat = cleanShape[0].lat * Math.PI / 180;
    const R = 6371000; // we're using this in a few places so we should probably factor it out in case we need to change it
    function toCartesian(pt: { lon: number, lat: number }) {
        return {
            x: (pt.lon * Math.PI / 180) * Math.cos(refLat) * R,
            y: (pt.lat * Math.PI / 180) * R,
            original: pt
        };
    }
    const shapeCart = cleanShape.map(toCartesian);
    const stopsCart = stops.map(toCartesian);

    // dot product projection
    function projectPointToSegment(p, v, w) {
        const l2 = Math.pow(w.x - v.x, 2) + Math.pow(w.y - v.y, 2);
        if (l2 === 0) return { t: 0, distSq: Math.pow(p.x - v.x, 2) + Math.pow(p.y - v.y, 2) };
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t)); // Clamp to ensure it stays on the segment
        const projX = v.x + t * (w.x - v.x);
        const projY = v.y + t * (w.y - v.y);
        const distSq = Math.pow(p.x - projX, 2) + Math.pow(p.y - projY, 2);
        return { t, distSq };
    }

    let currentSegmentStart = 0;
    const mappedStops =[];
    for (let i = 0; i < stopsCart.length; i++) {
        const stop = stopsCart[i];
        let bestSegment = currentSegmentStart;
        let bestDistSq = Infinity;
        let bestT = 0;
        // look for best match
        for (let j = currentSegmentStart; j < shapeCart.length - 1; j++) {
            const proj = projectPointToSegment(stop, shapeCart[j], shapeCart[j+1]);
            if (proj.distSq < bestDistSq) {
                bestDistSq = proj.distSq;
                bestSegment = j;
                bestT = proj.t;
            }
        }
        mappedStops.push({
            stopData: stop.original,
            segmentIndex: bestSegment,
            t: bestT
        });
        // start after current stop
        currentSegmentStart = bestSegment; 
    }

    mappedStops.sort((a, b) => {
        if (a.segmentIndex === b.segmentIndex) return a.t - b.t;
        return a.segmentIndex - b.segmentIndex;
    });

    const finalPath =[];
    finalPath.push(mappedStops[0].stopData);
    let currentShapeIndex = mappedStops[0].segmentIndex + 1;
    for (let i = 1; i < mappedStops.length; i++) {
        while (currentShapeIndex <= mappedStops[i].segmentIndex) {
            finalPath.push(cleanShape[currentShapeIndex]);
            currentShapeIndex++;
        }
        finalPath.push(mappedStops[i].stopData);
    }

    // TODO: refactor augmentWithRailRoute and reuse the interstop, interpolation, compression logic here too
    return finalPath;
}

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

            const straightLineDist = haversineDist(
                { lon: startWp.lng, lat: startWp.lat },
                { lon: endWp.lng, lat: endWp.lat }
            ) || 0;

            if (straightLineDist > 0 && totalLegDist > straightLineDist * 3) {
                console.warn(`[railRoute] Leg ${i} route too long (${totalLegDist.toFixed(1)}km vs ${straightLineDist.toFixed(1)}km straight), falling back to direct line`);
                augmentedPoints.push({
                    ...startWp,
                    isInterstop: false,
                });
                if (i === route.legs.length - 1) {
                    augmentedPoints.push({
                        ...endWp,
                        isInterstop: false,
                    });
                }
                continue;
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
