import races from '../assets/races.json';

const INSANE_JS_MONTH_MODIFIER = 1;
const BASE_DATE = [2026,1 - INSANE_JS_MONTH_MODIFIER,20]; // NB: JS months, but not days, are zero-based (really)

export const TODAYS_DATE = new Date();

export function getDailyRaceIndex(date: Date = TODAYS_DATE) {
    // NB: strings are assumed to be zulu time, numbers are assumed to be local time and are then converted to zulu time. obviously.
    const d1 = new Date(BASE_DATE[0], BASE_DATE[1], BASE_DATE[2]);
    const d2 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffTime = d2.getTime() - d1.getTime();

    // round not floor because of DST 23-hour days
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
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
