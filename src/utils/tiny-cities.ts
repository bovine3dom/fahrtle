import { createResource, createMemo, type Accessor } from 'solid-js';
import tinyCitiesUrl from '../assets/tiny-cities.json?url';
import KDBush from 'kdbush';
import { around } from 'geokdbush';
import type { Coords } from './geo';

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

export const cityDbPromise = fetchCityData();
const [cityDb] = createResource(() => cityDbPromise);

export const createClosestCity = (coords: Accessor<Coords | null | undefined>) => {
    return createMemo(() => {
        const db = cityDb();
        const c = coords();
        if (!db) return "...";
        if (!c) return "";

        const { tree, cities } = db;
        const { lat, lon } = c;

        const results = around(tree, lon, lat, 1);

        if (results.length === 0) return "Unknown Location";

        const idx = results[0] as number;
        return `${cities[idx].name}, ${cities[idx].country_code}`;
    });
};
