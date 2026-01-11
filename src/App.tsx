// ==> src/App.tsx <==
import { Suspense, lazy, For, createSignal, onMount, onCleanup } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $players, $myPlayerId, $roomState, $countdownEnd, toggleReady } from './store';
import { getServerTime, getRealServerTime } from './time-sync';
import Lobby from './Lobby';
import Clock from './Clock';
import { flyToPlayer } from './Map';

const MapView = lazy(() => import('./Map'));

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate);
  const players = useStore($players);
  const myId = useStore($myPlayerId);
  const roomState = useStore($roomState);
  const countdownEnd = useStore($countdownEnd);

  const [timeLeft, setTimeLeft] = createSignal<number | null>(null);

  onMount(() => {
    const interval = setInterval(() => {
      const end = countdownEnd();
      if (end) {
        const remaining = Math.max(0, Math.ceil((end - getRealServerTime()) / 1000));
        setTimeLeft(remaining);
      } else {
        setTimeLeft(null);
      }
    }, 100);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <>
      {!room() ? (
        <Lobby />
      ) : (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>

          {/* Overlay UI */}
          <div style={{
            position: 'absolute', top: '10px', left: '10px', 'z-index': 10,
            background: 'rgba(255,255,255,0.9)', padding: '12px', 'border-radius': '8px',
            'box-shadow': '0 2px 10px rgba(0,0,0,0.1)', 'min-width': '200px'
          }}>
            {/* Header Info */}
            <div style={{ 'margin-bottom': '8px' }}>
              <div style={{ 'font-size': '1.1em', 'font-weight': 'bold' }}>Room: {room()}</div>
              <Clock />
              <div style={{ 'font-size': '0.85em', 'color': '#d97706', 'margin-top': '2px' }}>
                Time Dilation: {rate().toFixed(2)}x
              </div>
            </div>

            {/* Player List */}
            <div style={{
              'margin-top': '10px',
              'padding-top': '8px',
              'border-top': '1px solid #ccc'
            }}>
              <div style={{ 'font-size': '0.75em', 'text-transform': 'uppercase', 'color': '#666', 'margin-bottom': '6px', 'letter-spacing': '0.5px' }}>
                Active Pilots
              </div>
              <div style={{ 'max-height': '200px', 'overflow-y': 'auto' }}>
                <For each={Object.values(players()).sort((a, b) => a.id.localeCompare(b.id))}>
                  {(p) => (
                    <div
                      onClick={() => flyToPlayer(p.id)}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.05)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      style={{
                        display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '4px',
                        'font-weight': p.id === myId() ? '800' : '400',
                        'color': p.id === myId() ? '#0f172a' : '#334155',
                        cursor: 'pointer',
                        padding: '4px',
                        'border-radius': '4px',
                        transition: 'background 0.2s',
                      }}>
                      <div style={{
                        width: '10px', height: '10px', 'border-radius': '50%',
                        background: p.color, 'flex-shrink': 0,
                        'border': '1px solid rgba(0,0,0,0.2)'
                      }} />
                      <span style={{
                        'font-size': '0.9em',
                        'white-space': 'nowrap',
                        'overflow': 'hidden',
                        'text-overflow': 'ellipsis',
                        'flex': 1
                      }}>
                        {p.id} {p.id === myId() ? '(You)' : ''}
                      </span>
                      {roomState() !== 'RUNNING' && (
                        p.isReady ? (
                          <span style={{ color: '#059669', 'font-size': '0.8em', 'font-weight': 'bold' }}>✓</span>
                        ) : (
                          <span style={{ color: '#94a3b8', 'font-size': '0.8em' }}>...</span>
                        )
                      )}
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Footer Actions */}
            <div style={{ 'margin-top': '12px', 'border-top': '1px solid #ccc', 'padding-top': '8px' }}>
              {roomState() !== 'RUNNING' && (
                <button
                  onClick={() => toggleReady()}
                  style={{
                    width: '100%', padding: '10px', 'background': players()[myId()!]?.isReady ? '#f1f5f9' : '#3b82f6',
                    color: players()[myId()!]?.isReady ? '#475569' : 'white',
                    border: '1px solid #cbd5e1', 'border-radius': '4px', cursor: 'pointer',
                    'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                  }}
                >
                  {players()[myId()!]?.isReady ? 'Unready' : 'Ready Up'}
                </button>
              )}
              <button
                onClick={() => leaveRoom()}
                style={{
                  width: '100%', padding: '6px', 'background': '#fee2e2', color: '#991b1b',
                  border: '1px solid #fecaca', 'border-radius': '4px', cursor: 'pointer', 'font-size': '0.85em'
                }}
              >
                Leave Room
              </button>
              <div style={{ 'font-size': '0.75em', 'color': '#94a3b8', 'margin-top': '6px', 'text-align': 'center' }}>
                Click map to add waypoint
              </div>
            </div>
          </div>

          <Suspense fallback={
            <div style={{
              color: 'white', background: '#333', height: '100vh',
              display: 'flex', 'justify-content': 'center', 'align-items': 'center'
            }}>
              Loading Map Engine...
            </div>
          }>
            <MapView />
          </Suspense>

          {roomState() === 'COUNTDOWN' && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              'z-index': 100, background: 'rgba(0,0,0,0.8)', padding: '2rem 4rem',
              'border-radius': '16px', color: 'white', 'text-align': 'center',
              'pointer-events': 'none', 'backdrop-filter': 'blur(4px)'
            }}>
              <div style={{ 'font-size': '1.5rem', opacity: 0.8, 'margin-bottom': '8px' }}>Mission Starts In</div>
              <div style={{ 'font-size': '6rem', 'font-weight': 'bold', 'line-height': 1 }}>{timeLeft()}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default App;
