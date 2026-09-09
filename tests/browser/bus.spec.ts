import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, names, join, state, startRace, expectFinished } from './fixtures';
import manifest from './data/bus/manifest.json' with { type: 'json' };

type RecordedRequest = { query: string; file: string; sha256: string; status: number };
type Stop = { stop_name: string; stop_lat: number; stop_lon: number; arrival_time: string; departure_time: string };
const directory = new URL('./data/bus/', import.meta.url);
const normalize = (query: string) => query.replace(/\s+/g, ' ').trim();
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');

test.use({
  timezoneId: manifest.timezone,
  // The captured arrivals query exceeds the live service's row-read limit.
  expectedClickHouseError: { query: /toHour\(next_arrival\)/, status: 500 },
});

test('bus timetable boarding replays a captured X5 journey through both browsers', async ({ clients }) => {
  test.setTimeout(150_000);
  const capture = process.env.FAHRTLE_CAPTURE_BUS === '1';
  const recordings = new Map<string, { body: Buffer; status: number }>();
  const queries = new Map<string, string>();
  const hits = { departures: 0, arrivals: 0, boarding: 0 };
  const { journey } = manifest;
  const pages = [clients.alice, clients.bob];
  const errors: string[] = [];

  if (!capture) {
    expect(manifest.capturedAt, 'capture the fixture before running the offline test').toBeTruthy();
    for (const record of manifest.requests as RecordedRequest[]) {
      const body = await readFile(new URL(record.file, directory));
      expect(hash(body), `${record.file} capture hash`).toBe(record.sha256);
      recordings.set(normalize(record.query), { body, status: record.status });
    }
  }

  for (const page of pages) {
    await page.route(`${manifest.endpoint}**`, async route => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? '';
      if (query.includes('_stop_statistics_unmerged3')) return route.fallback();
      try {
        expect(route.request().method()).toBe('GET');
        expect(query.trim()).toMatch(/^SELECT\b/);
        expect(query).toMatch(new RegExp(`FROM transitous_everything_${manifest.league}_(edgelist_fahrtle2|stop_times_one_day_even_saner2)\\b`));
        const key = normalize(query);
        const kind = query.includes('_stop_times_') ? 'boarding' : query.includes('toHour(next_arrival)') ? 'arrivals' : 'departures';
        if (capture && !recordings.has(key)) {
          const response = await route.fetch({ maxRedirects: 0 });
          const body = await response.body();
          if (kind === 'arrivals' && !response.ok()) {
            expect(JSON.parse(body.toString()).exception).toContain('TOO_MANY_ROWS');
          } else {
            expect(response.ok()).toBe(true);
            expect(JSON.parse(body.toString()).exception).toBeUndefined();
          }
          recordings.set(key, { body, status: response.status() });
          queries.set(key, query);
        }
        const recording = recordings.get(key);
        expect(recording, `Unrecorded timetable query: ${key}`).toBeDefined();
        if (kind === 'boarding') {
          expect(query).toContain(`source = '${journey.source}'`);
          expect(query).toContain(`trip_id = '${journey.tripId}'`);
          expect(query).toContain(`sane_route_id = '${journey.routeId}'`);
          expect(query).toContain(`departure_time >= '${journey.departure}'`);
        }
        hits[kind]++;
        await route.fulfill({ contentType: 'application/json', ...recording });
      } catch (error) {
        errors.push(String(error));
        await route.abort();
      }
    });
  }

  const room = `bus-${Date.now()}`;
  await join(pages[0], room, names[0]);
  await join(pages[1], room, names[1]);
  await pages[0].getByPlaceholder('e.g. 55.953, -3.188').fill(journey.start.join(', '));
  await pages[0].getByPlaceholder('e.g. 51.507, -0.127').fill(journey.finish.join(', '));
  await pages[0].locator('input[type="time"]').fill(manifest.startTime);
  await pages[0].getByRole('button', { name: 'Confirm settings', exact: true }).click();
  await expect(pages[0].getByRole('button', { name: /Synced/ })).toBeDisabled();

  // Query while JOINING so the H3 cell and time-of-day query remain deterministic.
  for (const page of pages) {
    expect((await state(page)).bounds.league).toBe(manifest.league);
    const point = await page.evaluate(([lat, lng]) => {
      const map = window.mapInstance;
      map.stop();
      map.jumpTo({ center: [lng, lat], zoom: 16 });
      const point = map.project([lng, lat]);
      const rect = map.getCanvas().getBoundingClientRect();
      return { x: point.x + rect.x, y: point.y + rect.y };
    }, journey.start);
    await page.mouse.click(point.x, point.y);
    await page.locator('.departures-precise-btn').click();
    const row = page.locator('.desktop-row-content')
      .filter({ has: page.locator('.route-pill', { hasText: /^X5$/ }) })
      .filter({ has: page.locator('.col-time', { hasText: '11:00' }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(journey.headsign);
    await expect(row.locator('.col-board button')).toBeDisabled();
    await page.locator('.departure-board').getByTitle('Minimize', { exact: true }).click();
  }

  await startRace(pages);
  for (const page of pages) {
    await page.locator('.departure-board').getByTitle('Expand', { exact: true }).click();
    const row = page.locator('.desktop-row-content')
      .filter({ has: page.locator('.route-pill', { hasText: /^X5$/ }) })
      .filter({ has: page.locator('.col-time', { hasText: '11:00' }) });
    await row.getByTitle('Board', { exact: true }).click();
    await expect.poll(async () => {
      const s = await state(page);
      return s.players[s.myPlayerId].waypoints.length;
    }).toBe(5);
  }

  expect(hits.departures).toBeGreaterThanOrEqual(2);
  await expect.poll(() => hits.arrivals).toBeGreaterThanOrEqual(2);
  expect(hits.boarding).toBe(2);
  const boardingKey = [...recordings.keys()].find(query => query.includes('_stop_times_'))!;
  const stops: Stop[] = JSON.parse(recordings.get(boardingKey)!.body.toString()).data;
  expect(stops).toHaveLength(3);
  for (const page of pages) {
    const s = await state(page);
    const [spawn, walk, wait, ...ride] = s.players[s.myPlayerId].waypoints;
    expect(walk.isWalk).toBe(true);
    expect(wait.isWait).toBe(true);
    expect(wait.arrivalTime).toBeGreaterThan(walk.arrivalTime);
    expect(ride.map(wp => wp.stopName)).toEqual(stops.slice(1).map(stop => stop.stop_name));
    for (const [index, wp] of ride.entries()) {
      expect(wp.isWalk).toBe(false);
      expect(wp.isWait).toBe(false);
      expect(wp.isInterstop).toBe(false);
      expect(wp.emoji).toBe('\u{1f68c}');
      expect(wp.route_short_name).toBe(journey.route);
      expect(wp.route_departure_time).toBe(journey.departure);
      expect(wp.x).toBeCloseTo(stops[index + 1].stop_lon, 3);
      expect(wp.y).toBeCloseTo(stops[index + 1].stop_lat, 3);
      expect(wp.arrivalTime).toBeGreaterThan(wp.startTime);
    }
    // Timetable wall times are moved onto the game's day, with the app's one-minute arrival offset.
    expect(Math.abs(ride[0].arrivalTime - spawn.startTime - 8 * 60_000)).toBeLessThan(1000);
    expect(Math.abs(ride[1].arrivalTime - spawn.startTime - 11 * 60_000)).toBeLessThan(1000);
  }
  await expectFinished(pages);
  for (const page of pages) {
    const s = await state(page);
    const player = s.players[s.myPlayerId];
    expect(player.finishTime).toBeGreaterThan(player.waypoints[3].arrivalTime - player.waypoints[0].startTime);
    expect(player.finishTime).toBeLessThan(13 * 60_000);
  }
  await expect(pages[0].getByRole('button', { name: 'Race again!' })).toBeVisible();
  expect(errors).toEqual([]);

  if (capture) {
    expect(clients.errors, 'do not replace recordings after browser/network errors').toEqual([]);
    const requests: RecordedRequest[] = [];
    for (const [key, { body, status }] of [...recordings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const file = `response-${requests.length}.json`;
      await writeFile(new URL(file, directory), body);
      requests.push({ query: queries.get(key)!, file, sha256: hash(body), status });
    }
    await writeFile(new URL('manifest.json', directory), JSON.stringify({
      ...manifest, capturedAt: new Date().toISOString(), requests,
    }, null, 2) + '\n');
  }
});
