import type { Waypoint } from '../store';
import { getClosestCityObject, type CityInfo } from './tiny-cities';
import { haversineDist } from './geo';

const STATS_KEY = 'fahrtle_stats';

export interface PlayerStats {
  lastPlayedDate: string;
  daysPlayed: number;
  racesStarted: number;
  racesFinished: number;
  countriesVisited: string[];
  byCountry: Record<string, CountryStats>;
}

export interface CountryStats {
  totalTimeMs: number;
  totalDistanceKm: number;
  transportTimeMs: Record<string, number>;
  transportDistanceKm: Record<string, number>;
  transportCount: Record<string, number>;
}

interface SerializedPlayerStats {
  lastPlayedDate: string;
  daysPlayed: number;
  racesStarted: number;
  racesFinished: number;
  countriesVisited: string[];
  byCountry: Record<string, CountryStats>;
}

function createEmptyStats(): PlayerStats {
  return {
    lastPlayedDate: '',
    daysPlayed: 0,
    racesStarted: 0,
    racesFinished: 0,
    countriesVisited: [],
    byCountry: {},
  };
}

export function loadStats(): PlayerStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return createEmptyStats();
    const parsed: SerializedPlayerStats = JSON.parse(raw);
    return { ...parsed };
  } catch {
    return createEmptyStats();
  }
}

export function saveStats(stats: PlayerStats): void {
  try {
    const serialized: SerializedPlayerStats = {
      lastPlayedDate: stats.lastPlayedDate,
      daysPlayed: stats.daysPlayed,
      racesStarted: stats.racesStarted,
      racesFinished: stats.racesFinished,
      countriesVisited: stats.countriesVisited,
      byCountry: stats.byCountry,
    };
    localStorage.setItem(STATS_KEY, JSON.stringify(serialized));
  } catch {
    // storage full or unavailable
  }
}

async function getCountryForWaypoint(wp: Waypoint): Promise<string | null> {
  const city: CityInfo | null = await getClosestCityObject({ lat: wp.y, lon: wp.x });
  return city?.country_code ?? null;
}

function getTransportKey(wp: Waypoint): string {
  if (wp.isWalk) return '🚶';
  return wp.emoji ?? '❓';
}

export async function computeStatsDelta(
  stats: PlayerStats,
  newWaypoints: Waypoint[],
  isRaceStart: boolean,
  todayDate: string,
  previousWaypoint: Waypoint | null = null
): Promise<PlayerStats> {
  if (newWaypoints.length === 0 && !isRaceStart) return stats;

  const newStats: PlayerStats = {
    ...stats,
    lastPlayedDate: stats.lastPlayedDate,
    daysPlayed: stats.daysPlayed,
    racesStarted: stats.racesStarted,
    racesFinished: stats.racesFinished,
    countriesVisited: [...stats.countriesVisited],
    byCountry: JSON.parse(JSON.stringify(stats.byCountry)),
  };

  if (isRaceStart) {
    newStats.racesStarted += 1;
    if (stats.lastPlayedDate !== todayDate) {
      newStats.daysPlayed += 1;
      newStats.lastPlayedDate = todayDate;
    }
  }

  const countries = new Set(stats.countriesVisited);

  for (let i = 0; i < newWaypoints.length; i++) {
    const wp = newWaypoints[i];
    const country = await getCountryForWaypoint(wp);
    if (country) countries.add(country);

    const key = getTransportKey(wp);
    const durationMs = wp.arrivalTime - wp.startTime;

    let distKm = 0;
    let prevCoords = null;

    if (i === 0 && previousWaypoint) {
      prevCoords = { lat: previousWaypoint.y, lon: previousWaypoint.x };
    } else if (i > 0) {
      prevCoords = { lat: newWaypoints[i - 1].y, lon: newWaypoints[i - 1].x };
    }

    if (prevCoords) {
      const d = haversineDist(prevCoords, { lat: wp.y, lon: wp.x });
      if (d !== null) distKm = d;
    }

    const countryKey = country ?? 'unknown';
    if (!newStats.byCountry[countryKey]) {
      newStats.byCountry[countryKey] = {
        totalTimeMs: 0,
        totalDistanceKm: 0,
        transportTimeMs: {},
        transportDistanceKm: {},
        transportCount: {},
      };
    }

    const cs = newStats.byCountry[countryKey];
    cs.totalTimeMs += durationMs;
    cs.totalDistanceKm += distKm;
    cs.transportTimeMs[key] = (cs.transportTimeMs[key] ?? 0) + durationMs;
    cs.transportDistanceKm[key] = (cs.transportDistanceKm[key] ?? 0) + distKm;
    cs.transportCount[key] = (cs.transportCount[key] ?? 0) + 1;
  }

  newStats.countriesVisited = Array.from(countries);

  return newStats;
}
