import { createServer } from 'vite';
import type { ServerResponse } from 'node:http';
import { dependencies } from '../../package.json';

const port = Number(process.env.FAHRTLE_TEST_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
// Set these before importing the backend, which opens its database at module load.
// Never inherit a developer's SQLite filename or attach to an existing backend.
process.env.FAHRTLE_DB_PATH = ':memory:';
process.env.FAHRTLE_HOST = '127.0.0.1';
process.env.FAHRTLE_PORT = '0';
process.env.VITE_FAHRTLE_DRIVING_URL = `${origin}/__test/driving`;
const fetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== process.env.VITE_FAHRTLE_DRIVING_URL) throw new Error(`Unexpected backend fetch: ${url}`);
  return fetch(input, { ...init, redirect: 'error' });
}) as typeof globalThis.fetch;
const { server: backend } = await import('../../srv/server');
const backendURL = `http://127.0.0.1:${backend.port}`;
const websocketURL = `ws://127.0.0.1:${backend.port}`;

const requests: { coordinates: number[][]; response: ServerResponse; released: boolean }[] = [];
const frontend = await createServer({
  cacheDir: 'node_modules/.cache/fahrtle-browser',
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  optimizeDeps: {
    noDiscovery: true,
    include: Object.keys(dependencies).filter(name => !name.startsWith('@types/')),
  },
  define: {
    'import.meta.env.VITE_FAHRTLE_WS_URI': JSON.stringify(websocketURL),
    'import.meta.env.VITE_FAHRTLE_API_BASE_URL': JSON.stringify(backendURL),
    'import.meta.env.VITE_FAHRTLE_DRIVING_URL': JSON.stringify(process.env.VITE_FAHRTLE_DRIVING_URL),
  },
  plugins: [{
    name: 'browser-test-services',
    configureServer(vite) {
      vite.middlewares.use('/__test', async (req, res, next) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/config') {
          res.end(JSON.stringify({ backendURL, websocketURL, database: ':memory:' }));
        } else if (req.url === '/driving' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          requests.push({ coordinates: JSON.parse(body).coordinates, response: res, released: false });
        } else if (req.url === '/routes') {
          if (req.method === 'DELETE') {
            for (const request of requests) {
              if (!request.released) request.response.end(JSON.stringify({ features: [] }));
            }
            requests.length = 0;
          }
          res.end(JSON.stringify(requests.map(({ coordinates, released }, id) => ({ id, coordinates, released }))));
        } else if (/^\/routes\/\d+\/release$/.test(req.url ?? '') && req.method === 'POST') {
          const request = requests[Number(req.url!.split('/')[2])];
          if (!request || request.released || request.response.destroyed) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: 'No pending routing request' }));
            return;
          }
          request.released = true;
          request.response.end(JSON.stringify({
            features: [{
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: request.coordinates },
              properties: { segments: [{ steps: [{ way_points: [0, 1], duration: 120, instruction: 'Test drive' }] }] },
            }],
          }));
          res.end('{}');
        } else next();
      });
    },
  }],
}).catch(error => { backend.stop(true); throw error; });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    backend.stop(true);
    for (const request of requests) request.response.destroy();
    await frontend.close();
    process.exit(0);
  });
}
try {
  await frontend.listen();
} catch (error) {
  backend.stop(true);
  await frontend.close();
  throw error;
}
console.log(`Browser tests: ${origin}; backend ${backendURL}; SQLite :memory:`);
