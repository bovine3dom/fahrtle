import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GameBounds, Player } from '../../src/shared/gameLogic';
import { once } from 'node:events';

type GameState = {
  connected: boolean;
  currentRoom: string | null;
  myPlayerId: string;
  players: Record<string, Player>;
  roomState: 'JOINING' | 'COUNTDOWN' | 'RUNNING';
  clock: number;
  globalRate: number;
  bounds: GameBounds;
};
declare global {
  interface Window {
    getGameState(): GameState;
    mapInstance: MapLibreMap;
  }
}

export const START = [55.9533, -3.1883] as const;
export const FINISH = [55.9563, -3.1883] as const;
export const names = ['Alice', 'Bob'];
type Peer = {
  send(message: unknown): void;
  request(message: unknown, responseType: string): Promise<any>;
};

export const test = base.extend<{
  clients: { alice: Page; bob: Page; websocketURL: string; errors: readonly string[] };
  peer: Peer;
  expectedClickHouseError: { query: RegExp; status: number } | null;
}>({
  expectedClickHouseError: [null, { option: true }],
  clients: async ({ browser, baseURL, request, viewport, timezoneId, expectedClickHouseError }, use) => {
    const config = await (await request.get('/__test/config')).json();
    expect(config.database).toBe(':memory:');
    expect(new URL(config.backendURL).hostname).toBe('127.0.0.1');
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const context = await browser.newContext({ baseURL, viewport, timezoneId, serviceWorkers: 'block' });
        contexts.push(context);
        context.on('page', page => {
          page.on('pageerror', error => errors.push(error.message));
          page.on('response', response => {
            if (response.url().startsWith('https://compute.olie.science/ch/') && !response.ok()) {
              const query = new URL(response.url()).searchParams.get('query') ?? '';
              if (response.status() !== expectedClickHouseError?.status || !expectedClickHouseError?.query.test(query)) {
                errors.push(`ClickHouse returned ${response.status()}`);
              }
            }
          });
        });
        await context.addInitScript(origin => {
          if (location.origin !== origin) return;
          localStorage.setItem('fahrtle_tutorial_shown', 'true');
          if (!localStorage.getItem('fahrtle_settings')) {
            localStorage.setItem('fahrtle_settings', JSON.stringify({
              publicTransportLayer: false, hillShade: false, bathymetry: false,
              autoZoom: false, autoFollow: false,
            }));
          }
        }, baseURL);
        // Browser traffic is limited to owned services and explicit data fixtures.
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === baseURL && url.pathname === '/toner_ofm.json') {
            await route.fulfill({ json: {
              version: 8, name: 'Test map', sources: {},
              glyphs: `${baseURL}/__test/glyphs/{fontstack}/{range}.pbf`,
              layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8e8e8' } }],
            } });
          } else if (url.origin === baseURL && url.pathname.startsWith('/__test/glyphs/')) {
            await route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.alloc(0) });
          } else if (url.origin === 'https://compute.olie.science' && url.pathname === '/ch/' && route.request().method() === 'GET') {
            if (process.env.FAHRTLE_LIVE_CLICKHOUSE === '1') await route.continue();
            else await route.fulfill({ json: { data: [] } });
          } else if (url.origin === baseURL || url.origin === config.backendURL) {
            await route.continue();
          } else {
            errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
            await route.abort();
          }
        });
        const allowedSockets = [config.websocketURL, baseURL!.replace('http:', 'ws:')];
        // Allowed sockets are untouched native connections to our own servers.
        await context.routeWebSocket(url => !allowedSockets.includes(url.origin), socket => {
          errors.push(`Unexpected external WebSocket: ${socket.url()}`);
          void socket.close();
        });
      }
      await use({
        alice: await contexts[0].newPage(), bob: await contexts[1].newPage(),
        websocketURL: config.websocketURL,
        errors,
      });
    } finally {
      for (const context of contexts) await context.close();
      expect((await request.delete('/__test/routes')).ok()).toBe(true);
      expect(errors, 'browser exceptions or unexpected external connections').toEqual([]);
    }
  },
  peer: async ({ clients }, use) => {
    const socket = new WebSocket(clients.websocketURL);
    try {
      await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
      await use({
        send: message => socket.send(JSON.stringify(message)),
        request: (message, responseType) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.removeEventListener('message', receive);
            reject(new Error(`Timed out waiting for ${responseType}`));
          }, 5000);
          const receive = (event: MessageEvent) => {
            const response = JSON.parse(event.data);
            if (response.type !== responseType) return;
            clearTimeout(timeout);
            socket.removeEventListener('message', receive);
            resolve(response);
          };
          socket.addEventListener('message', receive);
          socket.send(JSON.stringify(message));
        }),
      });
    } finally {
      socket.close();
    }
  },
});

export { expect };
export const state = (page: Page) => page.evaluate(() => window.getGameState());

export async function join(page: Page, room: string, name: string) {
  await page.goto(`/?room=${room}`);
  await page.getByPlaceholder('Enter or create room ID').fill(room);
  await page.getByRole('textbox').nth(1).fill(name);
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect.poll(async () => (await state(page)).connected).toBe(true);
  await page.waitForFunction(() => window.mapInstance?.getLayer('routes-line'));
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
}

export async function configureRace(page: Page, robot = false, finish: readonly number[] = FINISH) {
  await page.getByPlaceholder('e.g. 55.953, -3.188').fill(START.join(', '));
  await page.getByPlaceholder('e.g. 51.507, -0.127').fill(finish.join(', '));
  await page.locator('input[type="time"]').fill('12:00');
  await page.getByRole('switch').setChecked(robot);
  await page.getByRole('button', { name: 'Confirm settings', exact: true }).click();
  await expect(page.getByRole('button', { name: /Synced/ })).toBeDisabled();
}

export async function startRace(pages: Page[]) {
  for (const page of pages) await page.getByRole('button', { name: 'Ready up', exact: true }).click();
  for (const page of pages) await expect.poll(async () => (await state(page)).roomState).toBe('RUNNING');
}

export async function walkToFinish(page: Page) {
  const point = await page.evaluate(() => {
    const [lat, lng] = window.getGameState().bounds.finish!;
    const map = window.mapInstance;
    map.stop();
    map.jumpTo({ center: [lng, lat], zoom: 16 });
    const { x, y } = map.project([lng, lat]);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: x + rect.x, y: y + rect.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.locator('.map-click-popup .walk-btn').click();
  await expect.poll(async () => {
    const s = await state(page);
    return s.players[s.myPlayerId].waypoints.length;
  }).toBe(2);
}

export async function expectFinished(pages: Page[]) {
  for (const page of pages) {
    await expect.poll(async () => {
      const s = await state(page);
      return names.every(name => s.players[name]?.finishTime != null);
    }, { timeout: 30_000 }).toBe(true);
  }
  const result = (await state(pages[0])).players;
  for (const name of names) {
    expect(result[name].finishTime).toBeGreaterThan(0);
    expect(result[name].waypoints[1].isWalk).toBe(true);
    for (const page of pages) expect((await state(page)).players[name].finishTime).toBe(result[name].finishTime);
  }
}

export async function expectClockAgreement(pages: Page[], peer: Peer, room: string) {
  await expect(async () => {
    const sync = await peer.request({ type: 'SYNC_REQUEST', roomId: room, clientSendTime: Date.now() }, 'SYNC_RESPONSE');
    for (const page of pages) {
      const sample = await page.evaluate(() => ({
        clock: window.getGameState().clock, rate: window.getGameState().globalRate, wallTime: Date.now(),
      }));
      expect(sample.rate).toBe(sync.rate);
      const expected = sync.serverTime + (sample.wallTime - sync.realTime) * sync.rate;
      // The UI clock is sampled periodically; allow 300 ms of real-time sampling/dispatch delay.
      expect(Math.abs(sample.clock - expected)).toBeLessThan(Math.max(1000, sync.rate * 300));
    }
  }).toPass({ timeout: 10_000 });
}
