import races from '../assets/races.json';

const BASE_DATE = '2026-01-20';

export const TODAYS_DATE = new Date();

export function getDailyRaceIndex(date: Date = TODAYS_DATE) {
    const base = new Date(BASE_DATE);
    const d1 = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const d2 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffTime = d2.getTime() - d1.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays % races.length;
}

export function getDailyRace(date: Date = TODAYS_DATE) {
    const index = getDailyRaceIndex(date);
    const race = races[index];

    const { start_lat, start_lon, finish_lat, finish_lon } = race;
    const start = [start_lat, start_lon];
    const finish = [finish_lat, finish_lon];

    const hour = 5 + (index % 18);
    const time = `${hour.toString().padStart(2, '0')}:00`;

    return {
        start: [start[0], start[1]] as [number, number],
        finish: [finish[0], finish[1]] as [number, number],
        time
    };
}
