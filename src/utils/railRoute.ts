import { haversineDist } from "./geo";
import simplify from 'simplify-js';

interface PointWithCoords {
    lng: number;
    lat: number;
    time?: number;
    timeStr?: string;
    stopName?: string;
    isWalk?: boolean;
    [key: string]: any;
}

interface RoutePoint extends PointWithCoords {
    isInterstop?: boolean;
}

function computeDistancesAndTimes(
    simplifiedPoints: [number, number][],
    startWp: PointWithCoords,
    endWp: PointWithCoords
): { pointDistances: number[]; totalLegDist: number; timeDiff: number } {
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

    const timeDiff = (endWp.time || 0) - (startWp.time || 0);

    return { pointDistances, totalLegDist, timeDiff };
}

export async function augmentWithShape(stops: any[], shapePoints: any[]) {
    if (stops.length === 0) return stops;
    if (shapePoints.length < 2) return stops;

    // dedup
    const cleanShape = [shapePoints[0]];
    for (let i = 1; i < shapePoints.length; i++) {
        if (shapePoints[i].lat !== shapePoints[i-1].lat || shapePoints[i].lon !== shapePoints[i-1].lon) {
            cleanShape.push(shapePoints[i]);
        }
    }
    const simplifiedShape = simplify(
        cleanShape.map(c => ({ x: c.lon, y: c.lat })),
        0.0025, // units in degrees
        true
    ).map(p => {return {lon: p.x, lat: p.y}})

    if (simplifiedShape.length < 2) return stops;

    // locally euclidean
    const refLat = simplifiedShape[0].lat * Math.PI / 180;
    const R = 6371000;
    function toCartesian(pt: { lon: number, lat: number }) {
        return {
            x: (pt.lon * Math.PI / 180) * Math.cos(refLat) * R,
            y: (pt.lat * Math.PI / 180) * R,
            original: pt
        };
    }
    const shapeCart = simplifiedShape.map(toCartesian);
    const stopsCart = stops.map(toCartesian);

    // dot product projection
    function projectPointToSegment(p: { x: number, y: number }, v: { x: number, y: number }, w: { x: number, y: number }) {
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
    const mappedStops: { stopData: any; segmentIndex: number; t: number }[] = [];
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

    if (mappedStops.some((stop, i) => i > 0 &&
        stop.segmentIndex + stop.t < mappedStops[i - 1].segmentIndex + mappedStops[i - 1].t)) return stops;

    const finalPath: RoutePoint[] =[];
    finalPath.push({ ...mappedStops[0].stopData, isInterstop: false });
    let currentShapeIndex = mappedStops[0].segmentIndex + 1;

    // Compute distances and times for the entire shape path
    const shapeCoords: [number, number][] = simplifiedShape.map(p => [p.lon, p.lat]);
    const { pointDistances } = computeDistancesAndTimes(
        shapeCoords,
        mappedStops[0].stopData,
        mappedStops[mappedStops.length - 1].stopData
    );

    const stopDistance = ({ segmentIndex, t }: typeof mappedStops[number]) =>
        pointDistances[segmentIndex] + t * (pointDistances[segmentIndex + 1] - pointDistances[segmentIndex]);

    for (let i = 1; i < mappedStops.length; i++) {
        const startStop = mappedStops[i - 1].stopData;
        const endStop = mappedStops[i].stopData;
        const legStartDist = stopDistance(mappedStops[i - 1]);
        const legEndDist = stopDistance(mappedStops[i]);
        const legDist = legEndDist - legStartDist;
        const legTimeDiff = (endStop.time || 0) - (startStop.time || 0);

        while (currentShapeIndex <= mappedStops[i].segmentIndex) {
            const segmentDistRatio = legDist === 0 ? 0 : (pointDistances[currentShapeIndex] - legStartDist) / legDist;
            const pointTime = startStop.time + segmentDistRatio * legTimeDiff;

            finalPath.push({
                ...startStop,
                isWalk: false,
                isWait: false,
                stopName: undefined,
                timeStr: undefined,
                lng: simplifiedShape[currentShapeIndex].lon,
                lat: simplifiedShape[currentShapeIndex].lat,
                time: pointTime,
                isInterstop: true,
            });
            currentShapeIndex++;
        }
        finalPath.push({ ...mappedStops[i].stopData, isInterstop: false });
    }

    return finalPath;
}
