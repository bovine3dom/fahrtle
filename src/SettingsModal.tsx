import { For, Show } from 'solid-js';
import { defaultPlayerSettings } from './utils/playerSettings';
import { $playerSettings, updateSetting } from './store';
import { useStore } from '@nanostores/solid';

interface SettingsModalProps {
    onClose: () => void;
}

const SettingsModal = (props: SettingsModalProps) => {
    const currentSettings = useStore($playerSettings);

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
                    'display': 'flex', 'flex-direction': 'column', 'gap': '16px',
                    'max-height': '90vh', 'overflow-y': 'auto'
                }}
            >
                <div style={{ 'text-align': 'center', 'margin-bottom': '8px' }}>
                    <div style={{ 'font-size': '1.5rem', 'font-weight': 'bold', 'color': '#0f172a' }}>Settings ⚙️</div>
                </div>

                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                    <For each={Object.entries(defaultPlayerSettings).filter(([_, config]) => !config.hidden)}>
                        {([key, config]) => (
                            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
                                <label style={{ 'font-size': '0.9em', 'font-weight': 'bold', 'color': '#334155' }}>
                                    {config.description}
                                </label>

                                <Show when={config.type === 'text'}>
                                    <input
                                        type="text"
                                        value={currentSettings()[key as keyof typeof currentSettings]}
                                        onInput={(e) => updateSetting(key, e.currentTarget.value)}
                                        style={{
                                            padding: '8px', 'border-radius': '6px', border: '1px solid #cbd5e1',
                                            'font-size': '1em'
                                        }}
                                    />
                                </Show>

                                <Show when={config.type === 'color'}>
                                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                                        <input
                                            type="color"
                                            value={currentSettings()[key as keyof typeof currentSettings]}
                                            onInput={(e) => updateSetting(key, e.currentTarget.value)}
                                            style={{
                                                padding: '0', 'border-radius': '6px', border: 'none',
                                                width: '40px', height: '40px', cursor: 'pointer'
                                            }}
                                        />
                                        <span style={{ 'font-family': 'monospace', 'color': '#64748b' }}>
                                            {currentSettings()[key as keyof typeof currentSettings]}
                                        </span>
                                    </div>
                                </Show>

                                <Show when={config.type === 'boolean'}>
                                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                                        <input
                                            type="checkbox"
                                            checked={currentSettings()[key as keyof typeof currentSettings] as boolean}
                                            onChange={(e) => updateSetting(key, e.currentTarget.checked)}
                                            style={{ transform: 'scale(1.2)', cursor: 'pointer' }}
                                        />
                                        <span style={{ 'font-size': '0.9em', 'color': '#475569' }}>
                                            {currentSettings()[key as keyof typeof currentSettings] ? 'Enabled' : 'Disabled'}
                                        </span>
                                    </div>
                                </Show>

                                <Show when={config.type === 'select'}>
                                    <select
                                        value={currentSettings()[key as keyof typeof currentSettings] as string}
                                        onChange={(e) => updateSetting(key, e.currentTarget.value)}
                                        style={{
                                            padding: '8px', 'border-radius': '6px', border: '1px solid #cbd5e1',
                                            'font-size': '1em', 'background': 'white'
                                        }}
                                    >
                                        <For each={(config as any).options}>
                                            {(opt) => <option value={opt}>{opt}</option>}
                                        </For>
                                    </select>
                                </Show>

                                <Show when={config.type === 'number'}>
                                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                                        <input
                                            type="range"
                                            value={currentSettings()[key as keyof typeof currentSettings] as number}
                                            min={config.min}
                                            max={config.max}
                                            step={config.step || 10}
                                            onInput={(e) => updateSetting(key, e.currentTarget.value)}
                                        />
                                        <span>
                                            {currentSettings()[key as keyof typeof currentSettings]}
                                        </span>
                                    </div>
                                </Show>
                            </div>
                        )}
                    </For>
                </div>

                <div style={{ display: 'flex', gap: '12px', 'margin-top': '8px' }}>
                    <button
                        onClick={props.onClose}
                        style={{
                            flex: 1, padding: '10px',
                            background: '#3b82f6',
                            color: 'white', border: 'none',
                            'border-radius': '8px', cursor: 'pointer',
                            'font-weight': 'bold', 'font-size': '0.9em'
                        }}
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
