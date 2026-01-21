// src/Lobby.tsx
import { createEffect, createSignal, onMount } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { connectAndJoin, type Difficulty, $isSinglePlayer } from './store';
import { generatePilotName } from './names';
import bgImage from './assets/h3_hero.png';
import favicon from '../public/favicon.svg';

export default function Lobby() {
  const generateRandomRoom = () => {
    const randomId = Math.random().toString(36).substring(2, 10) +
      Math.random().toString(36).substring(2, 10);
    return randomId;
  };

  const [room, setRoom] = createSignal(localStorage.getItem('fahrtle_room') || generateRandomRoom());
  const [user, setUser] = createSignal(localStorage.getItem('fahrtle_user') || generatePilotName());
  const [color, setColor] = createSignal(localStorage.getItem('fahrtle_color') || ('#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')));
  const [difficulty, setDifficulty] = createSignal<Difficulty>('Easy');

  const isSinglePlayer = useStore($isSinglePlayer);

  const handleJoin = (e?: Event) => {
    e?.preventDefault();
    const currentRoom = room();
    const currentUser = user();
    if (currentRoom && currentUser) {
      localStorage.setItem('fahrtle_user', currentUser);
      localStorage.setItem('fahrtle_color', color());
      localStorage.setItem('fahrtle_room', currentRoom);
      localStorage.setItem('fahrtle_singleplayer', String(isSinglePlayer()));

      const url = new URL(window.location.href);

      const startParam = url.searchParams.get('s');
      const finishParam = url.searchParams.get('f');
      const timeParam = url.searchParams.get('t');
      const difficultyParam = url.searchParams.get('d') as Difficulty;
      let initialBounds;

      if (startParam || finishParam || timeParam || difficultyParam) {
        const parse = (s: string | null) => s ? s.split(',').map(Number) as [number, number] : null;
        initialBounds = {
          start: parse(startParam),
          finish: parse(finishParam),
          time: decodeURIComponent(timeParam || ''),
          difficulty: difficultyParam || difficulty()
        };
      }

      url.searchParams.delete('s');
      url.searchParams.delete('f');
      url.searchParams.delete('t');
      url.searchParams.delete('d');
      url.searchParams.set('room', currentRoom);
      window.history.replaceState(null, '', url);
      connectAndJoin(currentRoom, currentUser, color(), initialBounds);
    }
  };

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedRoom = params.get('room');
    const sharedDifficulty = params.get('d') as Difficulty;
    if (sharedDifficulty) {
      setDifficulty(sharedDifficulty);
    }
    if (sharedRoom) {
      setRoom(sharedRoom);
      // auto-join to handle reloads
      if (localStorage.getItem('fahrtle_user') && localStorage.getItem('fahrtle_room') === sharedRoom) {
        handleJoin();
      }
    }
  });

  createEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', room());
    window.history.replaceState(null, '', url);
  })


  return (
    <div style={{
      display: 'flex',
      height: '100%',
      'justify-content': 'center',
      'align-items': 'center',
      color: 'white',
      'background-image': `linear-gradient(rgba(15, 23, 42, 0), rgba(15, 23, 42, 0.7)), url('${bgImage}')`,
      'background-size': 'cover',
      'background-position': 'center',
      'image-rendering': 'pixelated',
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
            src={favicon}
            alt="Logo"
            style={{ width: '72px', height: '72px' }}
          />
          <h2 style={{ margin: 0, 'text-align': 'center', 'font-family': 'monospace', 'font-size': '1.8rem', 'letter-spacing': '1px' }}>
            fahrtle
          </h2>
        </div>

        <div style={{
          display: 'flex',
          'background': 'rgba(15, 23, 42, 0.4)',
          'padding': '4px',
          'border-radius': '8px',
          'margin-bottom': '8px'
        }}>
          <button
            type="button"
            onClick={() => $isSinglePlayer.set(false)}
            style={{
              flex: 1,
              padding: '8px',
              border: 'none',
              'border-radius': '6px',
              background: !isSinglePlayer() ? '#3b82f6' : 'transparent',
              color: 'white',
              cursor: 'pointer',
              transition: 'all 0.2s',
              'font-weight': !isSinglePlayer() ? 'bold' : 'normal',
              'font-family': 'inherit'
            }}
          >
            Multiplayer
          </button>
          <button
            type="button"
            onClick={() => {
              $isSinglePlayer.set(true);
              setRoom('solo');
            }}
            style={{
              flex: 1,
              padding: '8px',
              border: 'none',
              'border-radius': '6px',
              background: isSinglePlayer() ? '#3b82f6' : 'transparent',
              color: 'white',
              cursor: 'pointer',
              transition: 'all 0.2s',
              'font-weight': isSinglePlayer() ? 'bold' : 'normal',
              'font-family': 'inherit'
            }}
          >
            Single player
          </button>
        </div>

        <div style={{ opacity: isSinglePlayer() ? 0.5 : 1, 'pointer-events': isSinglePlayer() ? 'none' : 'auto' }}>
          <label style={{ display: 'block', 'font-size': '0.8rem', 'margin-bottom': '4px' }}>Room ID</label>

          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={room()}
              onInput={e => setRoom(e.currentTarget.value)}
              placeholder="Enter or create room ID"
              style={{
                padding: '8px', 'border-radius': '4px', border: 'none',
                width: '160px', flex: '1'
              }}
              disabled={isSinglePlayer()}
            />
            <button
              type="button"
              onClick={() => setRoom(generateRandomRoom())}
              title="Generate Random ID"
              style={{
                background: '#475569', border: 'none', cursor: 'pointer',
                'border-radius': '4px', 'font-size': '1.2rem', padding: '0 8px'
              }}
              disabled={isSinglePlayer()}
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
            <div style={{ position: 'relative', width: '24px', height: '24px' }}>
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
                width: '24px', height: '24px', 'border-radius': '50%', background: color(),
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
      <a
        href="https://github.com/bovine3dom/fahrtle?tab=readme-ov-file#fahrtle"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: 'absolute',
          bottom: '24px',
          right: '24px',
          display: 'flex',
          'font-family': 'monospace',
          'align-items': 'center',
          gap: '12px',
          color: 'white',
          'text-decoration': 'none',
          background: 'rgba(15, 23, 42, 0.6)',
          padding: '12px 20px',
          'border-radius': '12px',
          'backdrop-filter': 'blur(8px)',
          'font-weight': '600',
          'font-size': '1.4rem',
          border: '1px solid rgba(255,255,255,0.1)',
          'box-shadow': '0 4px 12px rgba(0,0,0,0.2)',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(15, 23, 42, 0.9)';
          e.currentTarget.style.transform = 'translateY(-4px)';
          e.currentTarget.style.boxShadow = '0 8px 16px rgba(0,0,0,0.4)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(15, 23, 42, 0.6)';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
        }}
      >
        <svg height="32" width="32" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
        </svg>
        <span>readme.md</span>
      </a>
    </div>
  );
}
