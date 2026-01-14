// ==> src/Lobby.tsx <==
import { createSignal, onMount } from 'solid-js';
import { connectAndJoin } from './store';
import { generatePilotName } from './names';

export default function Lobby() {
  const [room, setRoom] = createSignal("room-1");
  const [user, setUser] = createSignal(generatePilotName());
  const [color, setColor] = createSignal('#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));

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
      connectAndJoin(room(), user(), color());
    }
  };

  // Generates a random alphanumeric string (Base36)
  const generateRandomRoom = () => {
    const randomId = Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 10);
    setRoom(randomId);
  };

  const bgImage = "/assets/h3_hero.png";

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      'justify-content': 'center',
      'align-items': 'center',
      color: 'white',
      background: `linear-gradient(rgba(15, 23, 42, 0), rgba(15, 23, 42, 0.7)), url('${bgImage}')`,
      'background-size': 'cover',
      'background-position': 'center',
      'background-repeat': 'no-repeat'
    }}>
      <form onSubmit={handleJoin} style={{
        display: 'flex', 'flex-direction': 'column', gap: '16px',
        background: 'rgba(51, 65, 85, 0.6)',
        'backdrop-filter': 'blur(1px)',
        padding: '2rem', 'border-radius': '12px', 'box-shadow': '0 10px 25px rgba(0,0,0,0.3)'
      }}>
        <div style={{ 
          display: 'flex', 
          'align-items': 'center', 
          'justify-content': 'center', 
          gap: '12px',
          'margin-bottom': '8px'
        }}>
          <img 
            src="/favicon.svg" 
            alt="Logo" 
            style={{ width: '72px', height: '72px' }}
          />
          <h2 style={{ margin: 0, 'text-align': 'center', 'font-size': '1.8rem', 'letter-spacing': '1px' }}>
            fahrtle
          </h2>
        </div>

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
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              value={user()} onInput={e => setUser(e.currentTarget.value)}
              style={{ padding: '8px', 'border-radius': '4px', border: 'none', width: '160px', flex: '1' }}
            />
            <div style={{ position: 'relative', width: '16px', height: '16px' }}>
              <input
                type="color"
                value={color()}
                onInput={e => setColor(e.currentTarget.value)}
                style={{
                  position: 'absolute', opacity: 0, width: '100%', height: '100%',
                  cursor: 'pointer', 'z-index': 2
                }}
              />
              <div style={{
                width: '16px', height: '16px', 'border-radius': '50%', background: color(),
                border: '2px solid white', 'box-shadow': '0 0 5px rgba(0,0,0,0.3)', 'flex-shrink': 0
              }} />
            </div>
          </div>
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
