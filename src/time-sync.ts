import { atom } from 'nanostores';

// The state needed to calculate "Virtual Server Time"
type ClockState = {
  anchorServer: number; // Server time at moment of sync
  anchorLocal: number;  // Local device time at moment of sync
  rate: number;         // 0 = paused, 1 = normal, 5 = fast, etc.
};

// Initialized with 1:1 time mapped to now
export const $clockState = atom<ClockState>({
  anchorServer: Date.now(),
  anchorLocal: Date.now(),
  rate: 1.0
});

// Second server clock (always 1:1 rate)
export const $realClockState = atom<ClockState>({
  anchorServer: Date.now(),
  anchorLocal: Date.now(),
  rate: 1.0
});

/**
 * Calculates the current Virtual Server Time.
 */
export function getServerTime() {
  const state = $clockState.get();
  const realDelta = Date.now() - state.anchorLocal;
  const virtualDelta = realDelta * state.rate;
  return state.anchorServer + virtualDelta;
}

/**
 * Calculates the actual Server Time (ignores rate).
 */
export function getRealServerTime() {
  const state = $realClockState.get();
  const realDelta = Date.now() - state.anchorLocal;
  // rate is always 1.0 for the real clock
  return state.anchorServer + realDelta;
}

/**
 * Called when we receive a CLOCK_SYNC message from WS
 */
export function syncClock(serverTime: number, realTime: number, rate: number, latency: number) {
  // Compensate for network travel time
  const adjustedServerTime = serverTime + latency;
  const adjustedRealTime = realTime + latency;

  $clockState.set({
    anchorServer: adjustedServerTime,
    anchorLocal: Date.now(),
    rate: rate
  });

  $realClockState.set({
    anchorServer: adjustedRealTime,
    anchorLocal: Date.now(),
    rate: 1.0 // Real time always flows at 1x
  });

  console.log(`Clocks Synced. Virtual: ${new Date(adjustedServerTime).toISOString()} (${rate}x), Real: ${new Date(adjustedRealTime).toISOString()}`);
}
