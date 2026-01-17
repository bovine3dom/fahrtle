import tinyCities from '../assets/tiny-cities.json';
import KDBush from 'kdbush';
import { around } from 'geokdbush';

const cityTree = new KDBush(tinyCities.length);
for (const { latitude, longitude } of tinyCities) {
    cityTree.add(longitude, latitude);
}
cityTree.finish();

export const findClosestCity = ({ latitude, longitude }: { latitude: number, longitude: number }) => {
    const idx = around(cityTree, longitude, latitude, 1)[0] as number;
    return tinyCities[idx].name + ', ' + tinyCities[idx].country_code;
}

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
