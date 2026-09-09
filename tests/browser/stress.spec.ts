import { randomUUID } from 'node:crypto';
import { test, expect, names, START, join, state, configureRace, startRace } from './fixtures';

test('long routes and many ghosts survive a browser reload', async ({ clients, peer }, testInfo) => {
  test.setTimeout(90_000);
  const { alice, bob } = clients;
  const waypointCount = 1000, ghostCount = 10;
  const room = `stress-${randomUUID()}`;
  await join(alice, room, names[0]);
  await join(bob, room, names[1]);
  await configureRace(alice);
  await startRace([alice, bob]);

  // This is a second connection for Alice, not an additional player.
  const joinMessage = { type: 'JOIN_ROOM', roomId: room, playerId: names[0] };
  const snapshot = await peer.request(joinMessage, 'ROOM_STATE');
  expect(Number.isFinite(snapshot.serverTime)).toBe(true);
  const syncLatency = async () => {
    const clientSendTime = performance.now();
    const response = await peer.request({ type: 'SYNC_REQUEST', roomId: room, clientSendTime }, 'SYNC_RESPONSE');
    const latencyMs = performance.now() - clientSendTime;
    expect(response.clientSendTime).toBe(clientSendTime);
    expect(Number.isFinite(response.serverTime)).toBe(true);
    return latencyMs;
  };
  const beforeLoadMs = await syncLatency();
  const waypoints = Array.from({ length: waypointCount }, (_, i) => ({
    x: START[1] + Math.sin(i / 10) * 0.00015,
    y: START[0] + Math.cos(i / 10) * 0.00015,
    startTime: snapshot.serverTime + i * 1000,
    arrivalTime: snapshot.serverTime + (i + 1) * 1000,
    speedFactor: 1, isInterstop: i % 50 !== 49,
  }));
  const ghosts = Array.from({ length: ghostCount }, (_, i) => ({
    playerName: `stress-${i}`, color: '#888888',
    waypoints: [snapshot.players[names[0]].waypoints[0], ...waypoints],
  }));
  peer.send({ type: 'ADD_WAYPOINTS_BATCH', waypoints });
  peer.send({ type: 'ADD_GHOSTS', ghosts });
  const afterLoadMs = await syncLatency();
  const loaded = await peer.request(joinMessage, 'ROOM_STATE');
  expect(Object.keys(loaded.players).sort()).toEqual([...names, ...ghosts.map(g => `\u{1F47B}-${g.playerName}`)].sort());
  for (const id of Object.keys(loaded.players)) {
    expect(loaded.players[id].isGhost).toBe(!names.includes(id));
    expect(loaded.players[id].waypoints).toHaveLength(id === names[1] ? 1 : waypointCount + 1);
    expect(loaded.players[id].finishTime).toBeNull();
  }
  const histories = (players: Awaited<ReturnType<typeof state>>['players']) =>
    Object.fromEntries(Object.entries(players).map(([id, p]) => [id, { isGhost: p.isGhost, waypoints: p.waypoints }]));
  const expectedHistories = histories(loaded.players);
  const assertLoaded = async (page: typeof alice) => {
    await expect.poll(async () => {
      const s = await state(page);
      return { connected: s.connected, room: s.currentRoom, phase: s.roomState,
        finiteClock: Number.isFinite(s.clock), histories: histories(s.players) };
    }).toEqual({ connected: true, room, phase: 'RUNNING', finiteClock: true, histories: expectedHistories });
    await expect.poll(() => page.evaluate(async () => {
      const source = window.mapInstance?.getSource('routes') as import('maplibre-gl').GeoJSONSource | undefined;
      const data = await source?.getData() as import('geojson').GeoJSON | undefined;
      return data?.type === 'FeatureCollection' ? data.features.flatMap(feature =>
        feature.geometry.type === 'LineString' ? [feature.geometry.coordinates.length] : []) : [];
    })).toEqual(Array(ghostCount + 1).fill(waypointCount + 1));
  };
  await assertLoaded(alice);
  await assertLoaded(bob);
  await testInfo.attach('stress-sync.json', {
    contentType: 'application/json', body: JSON.stringify({ waypointCount, ghostCount, beforeLoadMs, afterLoadMs }),
  });

  for (const page of [alice, bob]) {
    const sample = await page.evaluate(async () => {
      const started = performance.now(), clockStart = window.getGameState().clock;
      let frames = 0, maxFrameGapMs = 0, previous = started;
      await new Promise<void>((resolve, reject) => {
        let frame = 0;
        const timeout = setTimeout(() => {
          cancelAnimationFrame(frame);
          reject(new Error('RAF sample did not complete within 10 seconds'));
        }, 10_000);
        const tick = (now: number) => {
          maxFrameGapMs = Math.max(maxFrameGapMs, now - previous);
          previous = now;
          frames++;
          if (now - started >= 500) { clearTimeout(timeout); resolve(); }
          else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      });
      return { frames, maxFrameGapMs, elapsedMs: performance.now() - started,
        clockProgress: window.getGameState().clock - clockStart };
    });
    await testInfo.attach(`stress-raf-${page === alice ? 'alice' : 'bob'}.json`, {
      contentType: 'application/json', body: JSON.stringify(sample),
    });
    expect(sample.frames).toBeGreaterThan(1);
    expect(sample.maxFrameGapMs).toBeLessThan(2000);
    expect(Object.values(sample).every(Number.isFinite)).toBe(true);
    expect(sample.clockProgress).toBeGreaterThan(0);
  }
  await bob.reload();
  await assertLoaded(bob);
  await bob.waitForFunction(() => window.mapInstance?.getLayer('routes-line'));
  await expect(bob.locator('.maplibregl-canvas')).toBeVisible();
  await assertLoaded(alice);
});
