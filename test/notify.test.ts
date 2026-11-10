// Buyer notifications: every message lands in the outbox, and with a Resend key
// the same message is sent through Resend's REST API (stubbed here).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.RESEND_API_KEY = 're_test_key';
process.env.NOTIFY_FROM = 'Quorum <hello@quorum.test>';

const { openDb } = await import('../src/db.ts');
const { notify, recentNotifications, copy } = await import('../src/notify.ts');
openDb(':memory:');

test('a notification is recorded and emailed through Resend', async () => {
  const sent: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response('{"id":"email_1"}', { status: 200 });
  }) as typeof fetch;
  try {
    const m = copy('es', 'closed', { product: 'Cafetera', members: '7', amount: '$199', paid: '$165', link: 'https://quorum.test/q/1' });
    notify('ana@gmail.com', 'closed', m.subject, m.body, 'q_1');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal(sent[0].auth, 'Bearer re_test_key');
    assert.deepEqual(sent[0].body, { from: 'Quorum <hello@quorum.test>', to: ['ana@gmail.com'], subject: 'Tu grupo se formó: pagaste $165', text: m.body });
    const [row] = recentNotifications('q_1');
    assert.equal(row.status, 'sent');
    assert.match(row.body, /PayPal cobró \$165/);
  } finally {
    globalThis.fetch = real;
  }
});

test('demo addresses are recorded but never emailed, and a failed send is visible', async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"message":"domain not verified"}', { status: 403 });
  }) as typeof fetch;
  try {
    notify('ana.demo@example.com', 'joined', 'You are in', 'body', 'q_2');
    notify(null, 'joined', 'no address', 'body', 'q_2');
    notify('real@gmail.com', 'joined', 'You are in', 'body', 'q_2');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, 'only the deliverable address is sent');
    const rows = recentNotifications('q_2');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.email === 'ana.demo@example.com')!.status, 'recorded');
    assert.equal(rows.find((r) => r.email === 'real@gmail.com')!.status, 'failed (403)');
  } finally {
    globalThis.fetch = real;
  }
});
