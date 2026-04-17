import { createMemo, type Accessor } from 'solid-js';
import type { Coords } from './geo';
import { findClosestCity as _findClosestCity } from 'tiny-geocoder';

const findClosestCity = (lat: number, lon: number): string => {
    const city = _findClosestCity(lat, lon);
    return city?.name ?? "Unknown location";
};

export const getClosestCityObject = (lat: number, lon: number): string => {
    return findClosestCity(lat, lon);
};

export const createClosestCity = (coords: Accessor<Coords | null | undefined>) => {
    return createMemo(() => {
        const c = coords();
        if (!c) return "Unknown location";
        return findClosestCity(c.lat, c.lon);
    });
};
