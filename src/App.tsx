// ==> src/App.tsx <==
import { Suspense, lazy, For } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $players, $myPlayerId } from './store';
import Lobby from './Lobby';
import Clock from './Clock';

const MapView = lazy(() => import('./Map'));

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate);
  const players = useStore($players);
  const myId = useStore($myPlayerId);

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
            'box-shadow': '0 2px 10px rgba(0,0,0,0.1)', minWidth: '200px'
          }}>
            {/* Header Info */}
            <div style={{ 'margin-bottom': '8px' }}>
              <div style={{ 'font-size': '1.1em', 'font-weight': 'bold' }}>Room: {room()}</div>
              <Clock />
              <div style={{'font-size':'0.85em', 'color':'#d97706', 'margin-top':'2px'}}>
                Time Dilation: {rate().toFixed(2)}x
              </div>
            </div>

            {/* Player List */}
            <div style={{ 
              'margin-top': '10px', 
              'padding-top': '8px', 
              'border-top': '1px solid #ccc' 
            }}>
              <div style={{'font-size':'0.75em', 'text-transform':'uppercase', 'color':'#666', 'margin-bottom':'6px', 'letter-spacing':'0.5px'}}>
                Active Pilots
              </div>
              <div style={{ 'max-height': '200px', 'overflow-y': 'auto' }}>
                <For each={Object.values(players())}>
                  {(p) => (
                    <div style={{ 
                      display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '4px',
                      'font-weight': p.id === myId() ? '800' : '400',
                      'color': p.id === myId() ? '#0f172a' : '#334155'
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
                        'max-width': '140px'
                      }}>
                        {p.id} {p.id === myId() ? '(You)' : ''}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Footer Actions */}
            <div style={{ 'margin-top': '12px', 'border-top': '1px solid #ccc', 'padding-top': '8px' }}>
              <button 
                onClick={() => leaveRoom()} 
                style={{
                  width: '100%', padding: '6px', 'background': '#fee2e2', color: '#991b1b', 
                  border: '1px solid #fecaca', 'border-radius': '4px', cursor: 'pointer', 'font-size': '0.85em'
                }}
              >
                Leave Room
              </button>
              <div style={{'font-size':'0.75em', 'color':'#94a3b8', 'margin-top':'6px', 'text-align': 'center'}}>
                Click map to add waypoint
              </div>
            </div>
          </div>

          <Suspense fallback={
            <div style={{
              color:'white', background:'#333', height:'100vh', 
              display:'flex', 'justify-content':'center', 'align-items':'center'
            }}>
              Loading Map Engine...
            </div>
          }>
            <MapView />
          </Suspense>
        </div>
      )}
    </>
  );
}

export default App;
