import { Show } from 'solid-js';

export function CountdownOverlay(props: { timeLeft: number | null }) {
  return (
    <Show when={props.timeLeft !== null}>
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        'z-index': 100, background: 'rgba(0,0,0,0.8)', padding: '2rem 4rem',
        'border-radius': '16px', color: 'white', 'text-align': 'center',
        'pointer-events': 'none', 'backdrop-filter': 'blur(4px)'
      }}>
        <div style={{ 'font-size': '1.5rem', opacity: 0.8, 'margin-bottom': '8px' }}>Mission starts in</div>
        <div style={{ 'font-size': '6rem', 'font-weight': 'bold', 'line-height': 1 }}>{props.timeLeft}</div>
      </div>
    </Show>
  );
}
