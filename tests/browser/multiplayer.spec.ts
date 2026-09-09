import { test, expect, names, join, state, configureRace, startRace, walkToFinish, expectFinished, expectClockAgreement } from './fixtures';

test('two browsers complete a race after a real disconnect and reconnect', async ({ clients, peer }) => {
  const { alice, bob } = clients;
  const room = `reconnect-${Date.now()}`;
  await join(alice, room, names[0]);
  await join(bob, room, names[1]);
  await configureRace(alice);
  await startRace([alice, bob]);
  await walkToFinish(alice);
  await walkToFinish(bob);
  await expect.poll(async () => (await state(alice)).globalRate).toBe(20);
  const before = (await state(bob)).players.Bob.waypoints;
  expect((await state(bob)).players.Bob.finishTime).toBeNull();
  await expectClockAgreement([alice, bob], peer, room);

  await bob.close();
  await expect.poll(async () => Number.isFinite((await state(alice)).players.Bob.disconnectedAt)).toBe(true);
  const reconnected = await bob.context().newPage();
  await reconnected.goto(`/?room=${room}`);
  await expect.poll(async () => (await state(reconnected)).connected).toBe(true);
  await expect.poll(async () => (await state(alice)).players.Bob.disconnectedAt).toBeNull();
  await expect.poll(async () => (await state(reconnected)).players.Bob.waypoints).toEqual(before);
  await expect.poll(async () => (await state(reconnected)).roomState).toBe('RUNNING');

  await expectClockAgreement([alice, reconnected], peer, room);
  await expectFinished([alice, reconnected]);
  await expect(alice.getByRole('button', { name: 'Race again!' })).toBeVisible();
});

test('rematches accept a delayed successful driver route on the new race timeline', async ({ clients, peer, request }) => {
  test.setTimeout(150_000);
  const { alice, bob } = clients;
  const pages = [alice, bob];
  const room = `rematch-${Date.now()}`;
  await join(alice, room, names[0]);
  await join(bob, room, names[1]);
  await configureRace(alice);
  await startRace(pages);
  for (const page of pages) await walkToFinish(page);
  await expectFinished(pages);

  for (const round of [1, 2]) {
    await alice.getByRole('button', { name: 'Race again!' }).click();
    for (const page of pages) {
      await expect.poll(async () => (await state(page)).roomState).toBe('JOINING');
      const s = await state(page);
      for (const name of names) {
        expect(s.players[name].finishTime).toBeNull();
        expect(s.players[name].isReady).toBe(false);
        expect(s.players[name].waypoints).toHaveLength(1);
      }
      expect(Object.values(s.players).filter(player => player.isGhost).length).toBeGreaterThanOrEqual(2);
      await expect(page.getByText('Mission complete!', { exact: true })).not.toBeVisible();
    }
    if (round === 2) break;

    await configureRace(alice, true);
    const previousRequests = (await (await request.get('/__test/routes')).json()).length;
    await startRace(pages);
    for (const page of pages) await walkToFinish(page);
    await expect.poll(async () => (await (await request.get('/__test/routes')).json()).length).toBe(previousRequests + 1);
    const start = (await state(alice)).players.Alice.waypoints[0].startTime;
    await expect.poll(async () => (await state(alice)).clock - start).toBeGreaterThan(2000);
    const driver = 'the-stig-\u{1f3ce}\ufe0f';
    for (const page of pages) expect((await state(page)).players[driver]).toBeUndefined();

    const pending = (await (await request.get('/__test/routes')).json())[previousRequests];
    expect(pending.released).toBe(false);
    expect((await request.post(`/__test/routes/${pending.id}/release`)).ok()).toBe(true);
    for (const page of pages) {
      await expect.poll(async () => (await state(page)).players[driver]?.waypoints.length).toBe(2);
      const waypoints = (await state(page)).players[driver].waypoints;
      expect(waypoints[0].startTime).toBe(start);
      expect(waypoints[1].arrivalTime).toBe(start + 120_000);
      expect(waypoints.map(wp => [wp.x, wp.y])).toEqual(pending.coordinates);
    }
    await expectClockAgreement(pages, peer, room);
    await expectFinished(pages);
    for (const page of pages) {
      await expect.poll(async () => (await state(page)).players[driver]?.finishTime).toBe(120_000);
    }
  }

  // A second rematch with new bounds must discard all previous replay/driver routes.
  await configureRace(alice, false, [55.9568, -3.1883]);
  for (const page of pages) {
    await expect.poll(async () => Object.values((await state(page)).players).filter(player => player.isGhost).length).toBe(0);
    await expect(page.getByRole('button', { name: 'Ready up', exact: true })).toBeEnabled();
  }
  await expectClockAgreement(pages, peer, room);
});
