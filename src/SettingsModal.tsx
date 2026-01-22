import { createSignal, For, Show } from 'solid-js';
import { defaultPlayerSettings } from './utils/playerSettings';
import { $playerSettings, updateSetting } from './store';

interface SettingsModalProps {
    onClose: () => void;
}

const SettingsModal = (props: SettingsModalProps) => {
    const currentSettings = $playerSettings.get();
    const [localSettings, setLocalSettings] = createSignal({ ...currentSettings });

    const handleSave = () => {
        const newSettings = localSettings();
        for (const key in newSettings) {
            updateSetting(key as any, newSettings[key as keyof typeof newSettings]);
        }
        props.onClose();
    };

    const updateLocal = (key: string, value: any) => {
        setLocalSettings(prev => ({ ...prev, [key]: value }));
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
                                        value={localSettings()[key as keyof typeof localSettings]}
                                        onInput={(e) => updateLocal(key, e.currentTarget.value)}
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
                                            value={localSettings()[key as keyof typeof localSettings]}
                                            onInput={(e) => updateLocal(key, e.currentTarget.value)}
                                            style={{
                                                padding: '0', 'border-radius': '6px', border: 'none',
                                                width: '40px', height: '40px', cursor: 'pointer'
                                            }}
                                        />
                                        <span style={{ 'font-family': 'monospace', 'color': '#64748b' }}>
                                            {localSettings()[key as keyof typeof localSettings]}
                                        </span>
                                    </div>
                                </Show>

                                <Show when={config.type === 'boolean'}>
                                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                                        <input
                                            type="checkbox"
                                            checked={localSettings()[key as keyof typeof localSettings] as boolean}
                                            onChange={(e) => updateLocal(key, e.currentTarget.checked)}
                                            style={{ transform: 'scale(1.2)', cursor: 'pointer' }}
                                        />
                                        <span style={{ 'font-size': '0.9em', 'color': '#475569' }}>
                                            {localSettings()[key as keyof typeof localSettings] ? 'Enabled' : 'Disabled'}
                                        </span>
                                    </div>
                                </Show>

                                <Show when={config.type === 'select'}>
                                    <select
                                        value={localSettings()[key as keyof typeof localSettings] as string}
                                        onChange={(e) => updateLocal(key, e.currentTarget.value)}
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
                            </div>
                        )}
                    </For>
                </div>

                <div style={{ display: 'flex', gap: '12px', 'margin-top': '8px' }}>
                    <button
                        onClick={props.onClose}
                        style={{
                            flex: 1, padding: '10px', background: '#f1f5f9',
                            color: '#475569', border: '1px solid #cbd5e1',
                            'border-radius': '8px', cursor: 'pointer',
                            'font-weight': 'bold', 'font-size': '0.9em'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        style={{
                            flex: 1, padding: '10px',
                            background: '#3b82f6',
                            color: 'white', border: 'none',
                            'border-radius': '8px', cursor: 'pointer',
                            'font-weight': 'bold', 'font-size': '0.9em'
                        }}
                    >
                        Save changes
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
