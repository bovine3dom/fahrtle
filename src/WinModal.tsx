import { createSignal } from 'solid-js';
import { type Player, $gameBounds } from './store';
import { getTravelSummary } from './utils/summary';

interface WinModalProps {
  player: Player;
  onSpectate: () => void;
  onClose: () => void;
}

const WinModal = (props: WinModalProps) => {
  const [copied, setCopied] = createSignal(false);
  const [stealthMode, setStealthMode] = createSignal(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(getTravelSummary(props.player, $gameBounds.get(), stealthMode()));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        background: 'rgba(0,0,0,0.5)', 'z-index': 1000,
        display: 'flex', 'justify-content': 'center', 'align-items': 'center',
        'backdrop-filter': 'blur(4px)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', padding: '24px', 'border-radius': '16px',
          'box-shadow': '0 4px 20px rgba(0,0,0,0.2)',
          'max-width': '90%', 'width': '400px',
          'display': 'flex', 'flex-direction': 'column', 'gap': '16px'
        }}
      >
        <div style={{ 'text-align': 'center' }}>
          <div style={{ 'font-size': '2rem', 'margin-bottom': '8px' }}>🎉</div>
          <div style={{ 'font-size': '1.5rem', 'font-weight': 'bold', 'color': '#0f172a' }}>Mission complete!</div>
          <div style={{ 'color': '#64748b' }}>You have reached your destination.</div>
        </div>

        <div style={{
          background: '#f8fafc', padding: '12px', 'border-radius': '8px',
          'font-family': 'monospace', 'font-size': '0.85em', 'white-space': 'pre-wrap',
          'max-height': '200px', 'overflow-y': 'auto', 'border': '1px solid #e2e8f0',
          'color': '#334155'
        }}>
          {getTravelSummary(props.player, $gameBounds.get(), stealthMode())}
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={props.onSpectate}
            style={{
              flex: 1, padding: '10px', background: 'white',
              color: '#0f172a', border: '1px solid #cbd5e1',
              'border-radius': '8px', cursor: 'pointer',
              'font-weight': 'bold', 'font-size': '0.9em'
            }}
          >
            Spectate 🔭
          </button>
          <button
            onClick={() => setStealthMode(!stealthMode())}
            style={{
              flex: 1, padding: '10px',
              background: stealthMode() ? '#10b981' : '#a7a7a7ff',
              color: 'white', border: 'none',
              'border-radius': '8px', cursor: 'pointer',
              'font-weight': 'bold', 'font-size': '0.9em',
              transition: 'background 0.2s'
            }}
          >
            {!stealthMode() ? 'Stealth 🥷' : 'Nerd 🤓'}
          </button>
          <button
            onClick={() => copyToClipboard}
            style={{
              flex: 1, padding: '10px',
              background: copied() ? '#10b981' : '#3b82f6',
              color: 'white', border: 'none',
              'border-radius': '8px', cursor: 'pointer',
              'font-weight': 'bold', 'font-size': '0.9em',
              transition: 'background 0.2s'
            }}
          >
            {copied() ? 'Copied! ✓' : 'Copy results 📋'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WinModal;
