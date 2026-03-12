import { useStore } from '@nanostores/solid';
import { $myPlayerId, $players, $clock } from '../store';
import { createMemo } from 'solid-js';

export const players = useStore($players);
export const myId = useStore($myPlayerId);
export const time = useStore($clock);

export const currentWpIndex = createMemo(() => {
  const p = players()[myId()!];
  if (!p) return -1;
  const t = time();
  return p.waypoints.findIndex((wp) => wp.arrivalTime > t);
});

export const nextWaypoint = createMemo(() => {
  const p = players()[myId()!];
  const idx = currentWpIndex();
  if (!p || idx === -1) return undefined;
  const nextReal = p.waypoints.map((wp, i) => ({ ...wp, originalIndex: i })).slice(idx).find(wp => !wp.isInterstop);
  return nextReal; // || p.waypoints[idx];
});
