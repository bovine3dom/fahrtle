import { Show, For } from 'solid-js';
import { stopImmediately } from '../store';
import { colours } from '../colours';

export function GetOffButton(props: {
  dropdownOpen: boolean;
  setDropdownOpen: (v: boolean) => void;
  actionFeedback: () => string | null;
  setActionFeedback: (v: string | null) => void;
  futureWaypoints: () => any[];
  nextWaypoint: () => any;
  stopImmediately?: (idx?: number) => void;
}) {
  const isWalking = () => props.nextWaypoint()?.isWalk || props.nextWaypoint()?.isWait;

  const handleStop = () => {
    if (isWalking()) {
      stopImmediately();
      props.setActionFeedback(props.nextWaypoint()?.isWait ? "Waiting stopped" : "Walking stopped");
    } else {
      stopImmediately(props.nextWaypoint()?.originalIndex);
      props.setActionFeedback(`Stopping at ${props.nextWaypoint()?.stopName}`);
    }
    setTimeout(() => props.setActionFeedback(null), 3000);
  };

  const label = () => props.actionFeedback() || (isWalking()
    ? (props.nextWaypoint()?.isWait ? 'Stop waiting' : 'Stop walking')
    : `${props.nextWaypoint()?.stopName || ''}`);

  return (
    <div style={{ display: 'flex', flex: 1, gap: '2px', position: 'relative', 'min-width': 0 }}>
      <button
        onClick={handleStop}
        style={{
          flex: 1, padding: '8px', background: isWalking() ? colours.success : colours.warning, color: '#fff',
          'border-top-left-radius': '4px', 'border-bottom-left-radius': '4px',
          'border-top-right-radius': props.futureWaypoints().length > 1 ? '0' : '4px',
          'border-bottom-right-radius': props.futureWaypoints().length > 1 ? '0' : '4px',
          cursor: 'pointer', border: `1px solid ${isWalking() ? colours.successDark : colours.warningDark}`,
          'border-right': props.futureWaypoints().length > 1 ? 'none' : undefined,
          'font-size': '0.9em', 'font-weight': 'bold',
          'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px',
          'min-width': 0
        }}
        title={isWalking() ? "Stop moving immediately" : "Stops at the next upcoming station and cancels remaining trip"}
      >
        <span style={{ 'flex-shrink': 0 }}>{props.actionFeedback() ? '' : '🛑'}</span>
        <span style={{ 'white-space': 'nowrap', 'overflow': 'hidden', 'text-overflow': 'ellipsis', 'flex': 1 }}>
          {label()}
        </span>
      </button>
      <Show when={props.futureWaypoints().length > 1}>
        <button
          onClick={(e) => { e.stopPropagation(); props.setDropdownOpen(!props.dropdownOpen); }}
          style={{
            padding: '0 4px', background: isWalking() ? colours.success : colours.warning, color: '#fff',
            'border-top-left-radius': '0px', 'border-bottom-left-radius': '0px',
            border: `1px solid ${isWalking() ? colours.successDark : colours.warningDark}`, cursor: 'pointer'
          }}
        >
          {props.dropdownOpen ? '▲' : '▼'}
        </button>
        <Show when={props.dropdownOpen}>
          <div
            ref={(el) => { requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); }}
            style={{
              position: 'absolute', top: '100%', left: 0, background: '#fff',
              border: '1px solid #ccc', 'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
              'border-radius': '4px', 'margin-top': '4px', 'min-width': '200px',
              'z-index': 100, 'max-height': '200px', 'overflow-y': 'auto'
            }}>
            <For each={props.futureWaypoints()}>
              {(wp) => (
                <div
                  onClick={() => {
                    stopImmediately(wp.originalIndex);
                    props.setDropdownOpen(false);
                    props.setActionFeedback(`Alighting scheduled for ${wp.stopName}`);
                    setTimeout(() => props.setActionFeedback(null), 3000);
                  }}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', 'font-size': '0.85em',
                    border: 'none', 'border-bottom': '1px solid #eee',
                    display: 'flex', 'align-items': 'center', gap: '8px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = colours.bg}
                  onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
                >
                  <span>{wp.emoji || '🏳️'}</span>
                  <span style={{ flex: 1, 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                    {wp.timeStr || ''} {wp.stopName || 'Unnamed stop'}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
