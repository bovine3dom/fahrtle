import { toggleSnooze, forceRealtime } from '../store';
import { colours } from '../colours';

export function SpeedControls(props: { mode: 'auto' | 'snooze' | 'realtime', compact?: boolean, canSnooze: () => boolean }) {
  const handleAutoClick = () => {
    if (props.mode === 'snooze') toggleSnooze();
    else if ((props.mode === 'realtime') || (props.mode === 'auto')) forceRealtime();
  };
  const handleSnoozeClick = () => {
    if (props.mode === 'auto') toggleSnooze();
    else if (props.mode === 'snooze') toggleSnooze();
    else if (props.mode === 'realtime') {
      forceRealtime();
      setTimeout(() => toggleSnooze(), 0);
    }
  };
  const handleRealtimeClick = () => {
    forceRealtime();
  };

  const btnStyle = (active: boolean, activeBg: string, activeBorder: string, radius: string) => ({
    flex: 1 as const, padding: props.compact ? '6px 8px' : '8px',
    background: active ? activeBg : colours.bg,
    color: active ? colours.white : colours.text,
    border: `1px solid ${active ? activeBorder : colours.border}`,
    'border-radius': radius,
    cursor: 'pointer' as const, 'font-size': props.compact ? '1em' : '0.9em',
    'font-weight': props.compact ? undefined as any : 'bold',
    'display': 'flex' as const, 'align-items': 'center' as const, 'justify-content': 'center' as const, gap: '4px',
    'box-shadow': active ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
    transform: active ? 'translateY(1px)' : 'none',
  });

  return (
    <div style={{ display: 'flex', 'flex-shrink': 0 }}>
      <button onClick={handleRealtimeClick} style={btnStyle(props.mode === 'realtime', colours.success, colours.successDark, '4px 0 0 4px')} title="Realtime (1x forced)">
        ⏱{!props.compact && ' Realtime'}
      </button>
      <button onClick={handleAutoClick} style={{ ...btnStyle(props.mode === 'auto', colours.primary, colours.primaryDark, '0'), 'border-right': 'none', 'border-left': 'none' }} title="Auto">
        ▶️{!props.compact && ' Auto'}
      </button>
      <button
        onClick={handleSnoozeClick}
        disabled={!props.canSnooze()}
        style={{
          ...btnStyle(props.mode === 'snooze', colours.primary, colours.primaryDark, '0 4px 4px 0'),
          ...(!props.canSnooze() ? { opacity: 0.4, cursor: 'not-allowed' as const } : {})
        }}
        title={props.canSnooze() ? "Snooze (500x)" : "Cannot snooze on final transport leg"}
      >
        ⏩{!props.compact && ' Snooze'}
      </button>
    </div>
  );
}
