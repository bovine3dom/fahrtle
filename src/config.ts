export const websocketUrl = import.meta.env.VITE_FAHRTLE_WS_URI
    ?? (import.meta.env.PROD ? '' : 'ws://localhost:8080');

const apiBase = import.meta.env.VITE_FAHRTLE_API_BASE_URL
    ?? (import.meta.env.PROD ? '' : 'http://localhost:8080/');
export const apiBaseUrl = apiBase && !apiBase.endsWith('/') ? `${apiBase}/` : apiBase;
