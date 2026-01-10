// ==> src/Lobby.tsx <==
import { createSignal, onMount } from 'solid-js';
import { connectAndJoin } from './store';

export default function Lobby() {
  const [room, setRoom] = createSignal("room-1");
  const [user, setUser] = createSignal("Pilot-" + Math.floor(Math.random() * 100));

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedRoom = params.get('room');
    if (sharedRoom) {
      setRoom(sharedRoom);
    }
  });

  const handleJoin = (e: Event) => {
    e.preventDefault();
    if (room() && user()) {
      const url = new URL(window.location.href);
      url.searchParams.set('room', room());
      window.history.replaceState(null, '', url);
      connectAndJoin(room(), user());
    }
  };

  // Generates a random alphanumeric string (Base36)
  const generateRandomRoom = () => {
    const randomId = Math.random().toString(36).substring(2, 10) + 
                     Math.random().toString(36).substring(2, 10);
    setRoom(randomId);
  };

  return (
    <div style={{
      display: 'flex', height: '100vh', 'justify-content': 'center', 'align-items': 'center',
      background: '#1e293b', color: 'white'
    }}>
      <form onSubmit={handleJoin} style={{
        display: 'flex', 'flex-direction': 'column', gap: '16px',
        background: '#334155', padding: '2rem', 'border-radius': '12px', 'box-shadow': '0 10px 25px rgba(0,0,0,0.5)'
      }}>
        <h2 style={{ margin: 0, 'text-align': 'center' }}>Mission Control</h2>

        <div>
          <label style={{ display: 'block', 'font-size': '0.8rem', 'margin-bottom': '4px' }}>Room ID</label>
          
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={room()} 
              onInput={e => setRoom(e.currentTarget.value)}
              placeholder="Enter Room ID"
              style={{ 
                padding: '8px', 'border-radius': '4px', border: 'none', 
                width: '160px', flex: '1' 
              }}
            />
            <button 
              type="button" 
              onClick={generateRandomRoom}
              title="Generate Random ID"
              style={{
                background: '#475569', border: 'none', cursor: 'pointer',
                'border-radius': '4px', 'font-size': '1.2rem', padding: '0 8px'
              }}
            >
              🎲
            </button>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', 'font-size': '0.8rem', 'margin-bottom': '4px' }}>Callsign</label>
          <input
            value={user()} onInput={e => setUser(e.currentTarget.value)}
            style={{ padding: '8px', 'border-radius': '4px', border: 'none', width: '210px' }}
          />
        </div>

        <button type="submit" style={{
          padding: '10px', 'background': '#3b82f6', color: 'white', border: 'none',
          'border-radius': '4px', 'font-weight': 'bold', cursor: 'pointer'
        }}>
          Launch
        </button>
      </form>
    </div>
  )
}
