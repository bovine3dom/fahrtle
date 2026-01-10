import { onMount, lazy, Suspense } from 'solid-js';
import { connectWebSocket } from './store';
import Clock from './Clock'; // Import the new component

const MapView = lazy(() => import('./Map'));


function App() {
  onMount(() => {
    connectWebSocket('ws://localhost:8080');
  });

  return (
    <div>
      {/* Overlay UI loads instantly */}
      <div style={{
        position: 'absolute', top: '10px', left: '10px', 'z-index': 10,
        background: 'rgba(255,255,255,0.9)', padding: '12px', 'border-radius': '8px'
      }}>
        <strong>Mission Control</strong><br/>
        <Clock />
      </div>

      {/* 2. Wrap Map in Suspense with a lightweight fallback */}
      <Suspense fallback={
        <div style={{ 
          display: 'flex', 
          'justify-content': 'center', 
          'align-items': 'center', 
          height: '100vh', 
          background: '#e5e5e5' 
        }}>
          Loading Map Engine...
        </div>
      }>
        <MapView />
      </Suspense>
    </div>
  );
}

export default App;
