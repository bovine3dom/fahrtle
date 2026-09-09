import { atom } from 'nanostores';

// The state needed to calculate "Virtual Server Time"
export type ClockState = {
  anchorServer: number; // Server time at moment of sync
  anchorLocal: number;  // Local device time at moment of sync
  rate: number;         // 0 = paused, 1 = normal, 5 = fast, etc.
};

// Initialized with 1:1 time mapped to now
const $clockState = atom<ClockState>({
  anchorServer: Date.now(),
  anchorLocal: getMonotonicTime(),
  rate: 1.0
});

// Second server clock (always 1:1 rate)
const $realClockState = atom<ClockState>({
  anchorServer: Date.now(),
  anchorLocal: getMonotonicTime(),
  rate: 1.0
});

/**
 * Calculates the current Virtual Server Time.
 */
export function getServerTime() {
  return projectClock($clockState.get(), getMonotonicTime());
}

/**
 * Calculates the actual Server Time (ignores rate).
 */
export function getRealServerTime() {
  return projectClock($realClockState.get(), getMonotonicTime());
}

export function getMonotonicTime() {
  return globalThis.performance?.now() ?? Date.now();
}

export function projectClock(state: ClockState, localTime: number) {
  return state.anchorServer + (localTime - state.anchorLocal) * state.rate;
}

export function createClockState(serverTime: number, rate: number, latency: number, localTime: number): ClockState {
  const safeLatency = Number.isFinite(latency) ? Math.max(0, latency) : 0;
  return {
    anchorServer: serverTime + safeLatency * rate,
    anchorLocal: localTime,
    rate,
  };
}

export function estimateServerMessageLatency(realTime: number) {
  return Number.isFinite(realTime) ? Math.max(0, getRealServerTime() - realTime) : 0;
}

/**
 * Called when we receive a CLOCK_SYNC message from WS
 */
export function syncClock(serverTime: number, realTime: number, rate: number, latency: number) {
  if (![serverTime, realTime, rate].every(Number.isFinite) || rate < 0) return;
  const now = getMonotonicTime();
  $clockState.set(createClockState(serverTime, rate, latency, now));
  $realClockState.set(createClockState(realTime, 1, latency, now));
}
