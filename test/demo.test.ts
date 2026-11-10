// The hosted demo must stay usable for weeks: it resets itself when it is used
// up or expired, but never while someone is using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.PAYPAL_MODE = 'mock';
process.env.ANTHROPIC_API_KEY = '';
process.env.CHANNEL3_API_KEY = '';

const { openDb, get, all, run } = await import('../src/db.ts');
const { demoStaleness, keepDemoFresh, seedDemo } = await import('../src/demo.ts');
const { addSimulatedBuyer, settleQuorum } = await import('../src/engine.ts');
const { quorumView, getQuorum } = await import('../src/models.ts');
openDb(':memory:');

const idle = () => {
  for (const t of ['events', 'agent_log', 'commitments', 'intents', 'quorums']) run(`UPDATE ${t} SET created_at = '2026-01-01T00:00:00.000Z'`);
};

test('an empty database is seeded, and a fresh demo is left alone', async () => {
  assert.equal(demoStaleness(), 'empty database');
  assert.equal(await keepDemoFresh(), 'empty database');
  assert.equal(demoStaleness(), null);
  idle();
  assert.equal(await keepDemoFresh(), null);
  assert.equal(all('SELECT id FROM merchants').length, 2);
});

test('a used demo is reset only once it is idle', async () => {
  const a = get<{ id: string }>("SELECT id FROM quorums WHERE summary LIKE '%espresso%'")!;
  await addSimulatedBuyer(a.id, 'judge.demo@example.com');
  await settleQuorum(a.id, { force: true });
  assert.equal(getQuorum(a.id)!.status, 'closed');
  assert.match(demoStaleness()!, /espresso/);
  assert.equal(await keepDemoFresh(), null, 'someone was just here');
  idle();
  assert.match((await keepDemoFresh())!, /espresso/);
  assert.equal(demoStaleness(), null);
  assert.equal(getQuorum(a.id), undefined);
  const fresh = get<{ id: string }>("SELECT id FROM quorums WHERE summary LIKE '%espresso%'")!;
  const view = quorumView(getQuorum(fresh.id)!);
  assert.equal(view.members, 4);
  assert.equal(view.minMembers, 5);
  assert.equal(all('SELECT id FROM merchants').length, 2);
});

test('an expired demo is reset, but not while PayPal holds a real authorization', async () => {
  run("UPDATE quorums SET closes_at = '2026-01-02T00:00:00.000Z'");
  idle();
  const q = get<{ id: string }>("SELECT id FROM quorums WHERE summary LIKE '%espresso%'")!;
  run("UPDATE commitments SET provider = 'paypal' WHERE id = (SELECT id FROM commitments WHERE quorum_id = ? LIMIT 1)", q.id);
  assert.equal(await keepDemoFresh(), null);
  run("UPDATE commitments SET provider = 'mock'");
  assert.match((await keepDemoFresh())!, /espresso/);
  assert.equal(demoStaleness(), null);
});
