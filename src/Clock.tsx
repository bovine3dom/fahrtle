import { onMount, onCleanup } from 'solid-js';
import { getServerTime } from './time-sync';

export default function Clock() {
  let spanRef: HTMLSpanElement | undefined;
  let frameId: number;
  let lastSecondString = '';

  onMount(() => {
    const update = () => {
      // 1. Get the synced time
      const now = getServerTime();
      
      // 2. Format to HH:MM:SS (Standard 24h format)
      // formatting a date object is slightly expensive, 
      // but doing it once per frame is acceptable on Android 8+
      const date = new Date(now);
      const timeString = date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      // 3. OPTIMIZATION: Only touch the DOM if the text is different
      // This ensures we only trigger a browser 'paint' once per second
      // even though we check 60 times a second.
      if (spanRef && timeString !== lastSecondString) {
        spanRef.innerText = timeString;
        lastSecondString = timeString;
      }

      frameId = requestAnimationFrame(update);
    };

    frameId = requestAnimationFrame(update);
  });

  onCleanup(() => cancelAnimationFrame(frameId));

  // Render a simple span that we control manually
  return <span ref={spanRef} style={{ "font-family": "monospace" }}>--:--:--</span>;
}
