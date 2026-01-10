import { atom } from 'nanostores';

// The state needed to calculate "Virtual Server Time"
type ClockState = {
  anchorServer: number; // Server time at moment of sync
  anchorLocal: number;  // Local device time at moment of sync
  rate: number;         // 0 = paused, 1 = normal, 5 = fast, etc.
};

// Initialize with 1:1 time mapped to now
export const $clockState = atom<ClockState>({
  anchorServer: Date.now(),
  anchorLocal: Date.now(),
  rate: 1.0
});

/**
 * Calculates the current Virtual Server Time.
 * This runs 60 times a second, so it stays dead simple.
 */
export function getServerTime() {
  const state = $clockState.get();
  
  // How many real milliseconds have passed since the last sync packet?
  const realDelta = Date.now() - state.anchorLocal;
  
  // Apply the playback rate
  const virtualDelta = realDelta * state.rate;
  
  return state.anchorServer + virtualDelta;
}

/**
 * Called when we receive a CLOCK_SYNC message from WS
 */
export function syncClock(serverTime: number, rate: number, latency: number) {
  // Compensate for network travel time
  const adjustedServerTime = serverTime + latency;

  $clockState.set({
    anchorServer: adjustedServerTime,
    anchorLocal: Date.now(), // The moment we finalized the sync
    rate: rate
  });
  
  console.log(`Clock Synced. Time: ${new Date(adjustedServerTime).toISOString()}, Rate: ${rate}x`);
}
