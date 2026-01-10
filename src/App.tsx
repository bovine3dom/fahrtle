// ==> src/App.tsx <==
import { Suspense, lazy } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate } from './store'; // Added $globalRate
import Lobby from './Lobby';
import Clock from './Clock';

const MapView = lazy(() => import('./Map'));

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate); // Subscribe to rate

  return (
    <>
      {!room() ? (
        <Lobby />
      ) : (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', top: '10px', left: '10px', 'z-index': 10,
            background: 'rgba(255,255,255,0.9)', padding: '12px', 'border-radius': '8px',
            'box-shadow': '0 2px 5px rgba(0,0,0,0.2)'
          }}>
            <strong>Room: {room()}</strong><br/>
            <Clock /><br/>
            {/* Display the active time dilation */}
            <div style={{'font-size':'0.9em', 'margin-top':'4px', 'color':'#d97706'}}>
              Time Dilation: {rate().toFixed(2)}x
            </div>
            
            <button onClick={() => leaveRoom()} style={{'margin-top':'8px'}}>Leave Room</button>
            <div style={{'font-size':'0.8em', 'color':'#666', 'margin-top':'5px'}}>
              Click map to add waypoint
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
