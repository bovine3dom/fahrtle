import { decode } from "@googlemaps/polyline-codec";
import { haversineDist } from "./geo";

/**
 * Augments a list of waypoints (stops) with a detailed rail path from signal.eu.org.
 * Interpolates timing based on the original stop times.
 */
export async function augmentWithRailRoute(points: any[]) {
    if (points.length < 2) return points;

    // Construct coordinates string for OSRM: lon,lat;lon,lat;...
    const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://signal.eu.org/osm/eu/route/v1/train/${coords}?overview=full&steps=true`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`[RailRoute] API returned ${response.status}`);
            return points;
        }
        const data = await response.json();

        if (!data.routes || data.routes.length === 0) {
            console.warn(`[RailRoute] No routes found`);
            return points;
        }

        const route = data.routes[0];
        const augmentedPoints: any[] = [];

        // OSRM legs correspond to segments between our input waypoints
        for (let i = 0; i < route.legs.length; i++) {
            const leg = route.legs[i];
            const startWp = points[i];
            const endWp = points[i + 1];

            const legCoords: [number, number][] = [];

            // Collect all points from all steps in this leg
            for (const step of leg.steps) {
                if (step.geometry) {
                    const decoded = decode(step.geometry);
                    for (const [lat, lng] of decoded) {
                        legCoords.push([lng, lat]); // [lon, lat] order used in the app
                    }
                }
            }

            // Deduplicate consecutive points
            const uniqueCoords = legCoords.filter((c, idx, self) =>
                idx === 0 || (c[0] !== self[idx - 1][0] || c[1] !== self[idx - 1][1])
            );

            if (uniqueCoords.length === 0) {
                augmentedPoints.push(startWp);
                continue;
            }

            // Calculate total distance along the decoded path to interpolate time
            const pointDistances: number[] = [0];
            let totalLegDist = 0;
            for (let j = 1; j < uniqueCoords.length; j++) {
                const d = haversineDist(uniqueCoords[j - 1], uniqueCoords[j]) || 0;
                totalLegDist += d;
                pointDistances.push(totalLegDist);
            }

            const timeDiff = endWp.time - startWp.time;

            // Process all points in this leg
            for (let j = 0; j < uniqueCoords.length; j++) {
                // To avoid duplicate points at stop locations, we skip the last point of each leg 
                // except for the very last leg of the entire route.
                if (i < route.legs.length - 1 && j === uniqueCoords.length - 1) {
                    continue;
                }

                const distRatio = totalLegDist === 0 ? 0 : pointDistances[j] / totalLegDist;
                const pointTime = startWp.time + distRatio * timeDiff;

                const isRealStop = j === 0 || (i === route.legs.length - 1 && j === uniqueCoords.length - 1);

                augmentedPoints.push({
                    ...startWp, // Keep original trip metadata (color, emoji, etc.)
                    lng: uniqueCoords[j][0],
                    lat: uniqueCoords[j][1],
                    time: pointTime,
                    // Keep stopName only for actual stop waypoints
                    stopName: isRealStop ? (j === 0 ? startWp.stopName : endWp.stopName) : undefined,
                    isInterstop: !isRealStop,
                    // isWalk only for the start of the entire trip (as in original logic)
                    isWalk: (i === 0 && j === 0) ? startWp.isWalk : false,
                });
            }
        }

        return augmentedPoints.length > 0 ? augmentedPoints : points;

    } catch (err) {
        console.error(`[RailRoute] Error fetching/parsing route:`, err);
        return points;
    }
}
