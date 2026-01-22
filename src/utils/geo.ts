import { createResource, createMemo, type Accessor } from 'solid-js';
import tinyCitiesUrl from '../assets/tiny-cities.json?url';
import KDBush from 'kdbush';
import { around } from 'geokdbush';

const fetchCityData = async () => {
    const response = await fetch(tinyCitiesUrl);
    const cities = await response.json();

    const tree = new KDBush(cities.length);
    for (const { latitude, longitude } of cities) {
        tree.add(longitude, latitude);
    }
    tree.finish();

    return { cities, tree };
};

const [cityDb] = createResource(fetchCityData);


export const createClosestCity = (coords: Accessor<[number, number] | null | undefined>) => {
    return createMemo(() => {
        const db = cityDb();
        const c = coords();
        if (!db || !c) return undefined;

        const { tree, cities } = db;
        const [lat, lon] = c;

        const results = around(tree, lon, lat, 1);

        if (results.length === 0) return "Unknown Location";

        const idx = results[0] as number;
        return `${cities[idx].name}, ${cities[idx].country_code}`;
    });
};

export const haversineDist = (coords1: [number, number] | null, coords2: [number, number] | null) => {
    if (!coords1 || !coords2) return null;
    const toRad = (x: number) => x * Math.PI / 180;
    const R = 6371; // km
    const dLat = toRad(coords2[1] - coords1[1]);
    const dLon = toRad(coords2[0] - coords1[0]);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(coords1[1])) * Math.cos(toRad(coords2[1])) *
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
