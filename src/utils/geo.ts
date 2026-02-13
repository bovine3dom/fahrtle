export interface Coords {
    lat: number;
    lon: number;
}

// haversine distance in km
export const haversineDist = (coords1: Coords | null, coords2: Coords | null) => {
    if (!coords1 || !coords2) return null;
    const toRad = (x: number) => x * Math.PI / 180;
    const R = 6371; // km
    const dLat = toRad(coords2.lat - coords1.lat);
    const dLon = toRad(coords2.lon - coords1.lon);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(coords1.lat)) * Math.cos(toRad(coords2.lat)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

export const lerp = (v0: number, v1: number, t: number) => v0 * (1 - t) + v1 * t;

export function getBearing(startLat: number, startLon: number, destLat: number, destLon: number) {
    const toRad = (deg: number) => deg * Math.PI / 180;
    const toDeg = (rad: number) => rad * 180 / Math.PI;

    const y = Math.sin(toRad(destLon - startLon)) * Math.cos(toRad(destLat));
    const x = Math.cos(toRad(startLat)) * Math.sin(toRad(destLat)) -
        Math.sin(toRad(startLat)) * Math.cos(toRad(destLat)) * Math.cos(toRad(destLon - startLon));

    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360; // Normalize to 0-360
}

// northbound, eastbound etc
export function bearingToCardinal(bearing: number) {
    if (bearing < 45 || bearing > 315) return 'Northbound';
    if (bearing >= 45 && bearing < 135) return 'Eastbound';
    if (bearing >= 135 && bearing < 225) return 'Southbound';
    return 'Westbound';
}

