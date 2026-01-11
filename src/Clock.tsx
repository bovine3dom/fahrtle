import { onMount, onCleanup } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { getServerTime } from './time-sync';
import { $clock, $playerTimeZone } from './store';
import { formatInTimeZone, getTimeZoneColor } from './timezone';

export default function Clock() {
  const zone = useStore($playerTimeZone);
  let spanRef: HTMLSpanElement | undefined;
  let frameId: number;
  let lastTimeString = '';

  const zoneDisplayName = () => {
    const z = zone();
    return z.split('/').pop()?.replace('_', ' ') || z;
  };

  onMount(() => {
    const update = () => {
      const now = getServerTime();
      $clock.set(now);

      // Format to local time
      const timeString = formatInTimeZone(now, zone(), true);

      if (spanRef && timeString !== lastTimeString) {
        spanRef.innerText = timeString;
        lastTimeString = timeString;
      }

      frameId = requestAnimationFrame(update);
    };

    frameId = requestAnimationFrame(update);
  });

  onCleanup(() => cancelAnimationFrame(frameId));

  return (
    <div style={{
      display: 'flex',
      "flex-direction": 'column',
      "align-items": 'center',
      background: getTimeZoneColor(zone()),
      padding: '4px 12px',
      "border-radius": '6px',
      color: '#fff',
      "font-family": 'monospace',
      "pointer-events": 'none',
      "user-select": 'none',
      transition: 'background 1.5s ease'
    }}>
      <span ref={spanRef} style={{ "font-size": "1.2rem", "font-weight": "bold" }}>--:--:--</span>
      <span style={{ "font-size": "0.6rem", opacity: 0.8, "text-transform": "uppercase" }}>{zoneDisplayName()}</span>
    </div>
  );
}
