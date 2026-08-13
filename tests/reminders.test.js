import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testStore = path.join(process.cwd(), 'tests', '.reminder-test-store.json');
fs.rmSync(testStore, { force: true });
process.env.MEMORY_STORE = testStore;

const memory = await import('../src/memory.js?reminder-tests');

test('parses compact and natural relative durations', () => {
  assert.equal(memory.parseReminderDuration('2min'), 2 * 60_000);
  assert.equal(memory.parseReminderDuration('in 2 hours'), 2 * 3_600_000);
  assert.equal(memory.parseReminderDuration('2 days'), 2 * 86_400_000);
  assert.equal(memory.parseReminderDuration('1 hour 30 minutes'), 90 * 60_000);
  assert.equal(memory.parseReminderDuration('tomorrow'), null);
});

test('stores a relative reminder and removes it after one delivery', async () => {
  memory._resetForTests([]);
  const requester = { id: 'u1', displayName: 'ErEN', user: { tag: 'ErEN#1' } };
  const ctx = {
    guild: { id: 'g1' },
    textChannel: { id: 'c1' },
    requester,
  };

  const before = Date.now();
  const result = memory.memoryHandlers.set_reminder(ctx, {
    content: 'check the oven',
    after: '2min',
  });
  const entry = memory._getEntriesForTests()[0];

  assert.match(result.done, /cleared after delivery/);
  assert.ok(entry.remindAt >= before + 2 * 60_000);
  assert.ok(entry.remindAt <= Date.now() + 2 * 60_000);

  const sent = [];
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (message) => sent.push(message),
      }),
    },
  };
  const spoken = [];

  const cleared = await memory._runReminderTickForTests(
    client,
    () => ({ speakAnnouncement: (message) => spoken.push(message) }),
    entry.remindAt + 1,
  );

  assert.equal(cleared, 1);
  assert.equal(memory._getEntriesForTests().length, 0);
  assert.equal(sent.length, 1);
  assert.equal(spoken.length, 1);

  const secondDelivery = await memory._runReminderTickForTests(
    client,
    () => ({ speakAnnouncement: () => {} }),
    Date.now() + 10 * 60_000,
  );
  assert.equal(secondDelivery, 0);
  fs.rmSync(testStore, { force: true });
});
