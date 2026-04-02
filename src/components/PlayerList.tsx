import { Show, For, createMemo } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $playerSpeeds, $playerDistances, updateSetting } from '../store';
import { formatDuration } from '../utils/time';
import { sensibleNumber } from '../utils/format';
import { calculateCO2Emissions } from '../utils/co2';
import { colours } from '../colours';

export function PlayerList(props: {
  sortedPlayerIds: () => string[];
  players: () => Record<string, any>;
  myId: () => string | null;
  roomState: () => 'JOINING' | 'COUNTDOWN' | 'RUNNING';
  time: () => number;
}) {
  const speeds = useStore($playerSpeeds);
  const distances = useStore($playerDistances);
  const getMedal = (rankIndex: number) => {
    if (rankIndex === 0) return '🥇';
    if (rankIndex === 1) return '🥈';
    if (rankIndex === 2) return '🥉';
    return '';
  };

  return (
    <div style={{
      'margin-top': '10px',
      'padding-top': '8px',
      'border-top': '1px solid #ccc'
    }}>
      <div style={{ 'font-size': '0.75em', 'text-transform': 'uppercase', 'color': '#666', 'margin-bottom': '6px', 'letter-spacing': '0.5px' }}>
        Active Pilots
      </div>
      <div style={{ 'max-height': '200px', 'overflow-y': 'auto' }}>
        <For each={props.sortedPlayerIds()}>
          {(id, index) => {
            const p = () => props.players()[id];
            const isFinished = createMemo(() => p().finishTime != null);
            const nextWpIndex = createMemo(() => p().segments.findIndex((s: any) => s.startTime > props.time() && !s.isInterstop));
            const nextWp = createMemo(() => p().waypoints[nextWpIndex()]);
            const mySpeed = createMemo(() => (speeds()[id] || 0).toFixed(0));
            const myDist = createMemo(() => sensibleNumber(distances()[id] || 0));

            return (
              <div
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.05)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                style={{
                  display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '4px',
                  'font-weight': p().id === props.myId() ? '800' : '400',
                  'color': p().id === props.myId() ? colours.textDark : colours.textBody,
                  padding: '4px',
                  'min-height': '42px',
                  'border-radius': '4px',
                  transition: 'background 0.2s',
                  'background': isFinished() ? 'rgba(255, 237, 74, 0.1)' : 'transparent',
                  'border': isFinished() ? '1px solid rgba(255, 215, 0, 0.3)' : '1px solid transparent'
                }}>
                <div style={{ position: 'relative', width: '12px', height: '12px', 'flex-shrink': 0 }}>
                  <div style={{
                    width: '12px', height: '12px', 'border-radius': '50%',
                    background: p().color,
                    'border': '1px solid rgba(0,0,0,0.2)'
                  }} />
                  <Show when={p().id === props.myId()}>
                    <input
                      type="color"
                      value={p().color}
                      onInput={(e) => updateSetting('color', e.currentTarget.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                        opacity: 0, cursor: 'pointer', 'z-index': 1
                      }}
                    />
                  </Show>
                </div>
                <div style={{ 'flex': 1, 'min-width': 0 }}>
                  <div style={{
                    'font-size': '0.9em',
                    'white-space': 'nowrap',
                    'overflow': 'hidden',
                    'text-overflow': 'ellipsis',
                  }}>
                    <Show when={isFinished()}>
                      <span style={{ "margin-right": "4px" }}>{getMedal(index())}</span>
                    </Show>
                    {p().id} {p().id === props.myId() ? '(You)' : ''} {p().forceRealtime ? '⏱' : (p().desiredRate || 1) > 1 && '💤'}
                  </div>
                  <Show when={isFinished()}>
                    <div style={{ 'font-size': '0.75em', 'color': colours.successDark, 'font-weight': 'bold' }}>
                      Finished in {formatDuration(p().finishTime!)}, {sensibleNumber(calculateCO2Emissions(p().waypoints))} kgCO₂e
                    </div>
                  </Show>
                  <Show when={!isFinished()}>
                    <Show when={nextWp()} fallback={
                      <Show when={p().viewingStopName}>
                        <div style={{
                          'overflow': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'display': 'block',
                          'font-size': '0.7em', 'color': colours.textMuted, 'margin-top': '0px', 'align-items': 'center', 'gap': '4px'
                        }}>
                          🔍 Looking at departures @ {p().viewingStopName}
                        </div>
                      </Show>
                    }>
                      {(wp) => (
                        <div style={{
                          'overflow': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'display': 'block',
                          'font-size': '0.7em', 'color': colours.textMuted, 'margin-top': '0px', 'align-items': 'center', 'gap': '4px'
                        }}>
                          <Show when={wp().route_short_name}>
                            <span
                              class="route-pill"
                              style={{
                                "background-color": wp().route_color ? `#${wp().route_color}` : '#333',
                                "color": '#fff'
                              }}
                            >
                              {wp().route_short_name}
                            </span>
                          </Show>
                          {wp().emoji + " " || ''} &rarr; {wp().stopName} {wp().timeStr ? `(${wp().timeStr})` : ''}
                        </div>
                      )}
                    </Show>
                  </Show>
                </div>

                <Show when={props.roomState() === 'RUNNING' && !isFinished()}>
                  <span style={{
                    'font-size': '0.75em',
                    'font-family': 'monospace',
                    'color': colours.textMuted,
                    'margin-right': '6px',
                    'min-width': '60px',
                    'text-align': 'right'
                  }}>
                    {mySpeed()} km/h {myDist()} km
                  </span>
                </Show>
                {props.roomState() !== 'RUNNING' && (
                  p().isReady ? (
                    <span style={{ color: colours.successDark, 'font-size': '0.8em', 'font-weight': 'bold' }}>✓</span>
                  ) : (
                    <span style={{ color: colours.textLight, 'font-size': '0.8em' }}>...</span>
                  )
                )}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
