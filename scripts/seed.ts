// Demo data: two fictional merchants, a catalog, two open groups and some
// waiting demand. Seeded buyers use simulated PayPal (provider "mock") so the
// demo works without sandbox accounts; real buyers use PayPal sandbox.
//
//   npm run seed            add demo data to the database
//   npm run seed -- --reset delete the database first
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { openDb, run } from '../src/db.ts';
import { createMerchant, createProduct, createQuorum, getProduct } from '../src/models.ts';
import { completeAuthorization, startCheckout } from '../src/engine.ts';
import { mockPayPal } from '../src/paypal/index.ts';
import { marketFor } from '../src/ai/catalog.ts';
import { ensureProductEmbedding, submitIntent } from '../src/ai/intent.ts';

if (process.argv.includes('--reset')) {
  const file = config.dbFile || join(config.dataDir, 'quorum.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  console.log('Database reset.');
}
openDb();

// Seeding must give the same demo every time, so the sample requests are routed by
// rules, not by the model. (Real requests typed into the app still use Claude.)
if (!process.argv.includes('--llm')) config.anthropic.apiKey = '';

const cafe = createMerchant('Café Altura', null);
const trail = createMerchant('Trailhead Supply', null);

const products = [
  createProduct({
    merchantId: cafe.id,
    title: 'Compact 15-bar espresso machine',
    category: 'coffee',
    description: 'Small-footprint espresso machine for one or two people, with a steam wand for milk drinks.',
    keywords: 'espresso machine, coffee maker, compact, latte, cappuccino, steam wand',
    listPrice: 199,
    floorPrice: 160,
    stock: 40,
    tiers: [{ min: 5, price: 179 }, { min: 8, price: 169 }],
  }),
  createProduct({
    merchantId: cafe.id,
    title: 'Conical burr coffee grinder',
    category: 'coffee',
    description: 'Adjustable conical burr grinder, from espresso to French press.',
    keywords: 'coffee grinder, burr grinder, espresso grind',
    listPrice: 129,
    floorPrice: 95,
    stock: 30,
    tiers: [{ min: 4, price: 115 }, { min: 8, price: 105 }],
  }),
  createProduct({
    merchantId: cafe.id,
    title: 'Electric gooseneck kettle',
    category: 'kitchen',
    description: 'Variable-temperature gooseneck kettle for pour-over coffee and tea.',
    keywords: 'kettle, gooseneck, pour over, tea, temperature control',
    listPrice: 69,
    floorPrice: 48,
    stock: 50,
    tiers: [{ min: 5, price: 59 }, { min: 10, price: 54 }],
  }),
  createProduct({
    merchantId: trail.id,
    title: 'Ultralight 2-person backpacking tent',
    category: 'outdoor',
    description: 'Freestanding two-person tent under 1.5 kg, three seasons.',
    keywords: 'tent, camping, backpacking, ultralight, 2 person, hiking',
    listPrice: 249,
    floorPrice: 190,
    stock: 25,
    tiers: [{ min: 5, price: 219 }, { min: 10, price: 199 }],
  }),
  createProduct({
    merchantId: trail.id,
    title: 'Insulated steel water bottle, 1 L',
    category: 'outdoor',
    description: 'Double-wall vacuum bottle that keeps drinks cold for 24 hours.',
    keywords: 'water bottle, insulated bottle, thermos, hiking',
    listPrice: 35,
    floorPrice: 22,
    stock: 200,
    tiers: [{ min: 6, price: 29 }, { min: 12, price: 26 }],
  }),
];
for (const p of products) await ensureProductEmbedding(getProduct(p.id)!);

const [espresso, , kettle] = products;
const groupA = createQuorum(getProduct(espresso.id)!, Number(process.env.SEED_GROUP_HOURS ?? 48), 'Group for: compact espresso machine');
const groupB = createQuorum(getProduct(kettle.id)!, Number(process.env.SEED_EXPIRING_MINUTES ?? 15) / 60, 'Group for: gooseneck kettle');

// Live market check for the seeded groups (empty without a Channel3 key).
for (const [group, product] of [[groupA, espresso], [groupB, kettle]] as const) {
  run('UPDATE quorums SET market_json = ? WHERE id = ?', JSON.stringify(await marketFor(product.title, product.list_price)), group.id);
}

async function simulatedMember(quorumId: string, text: string, email: string) {
  const r = await submitIntent(text, email);
  if (r.quorumId !== quorumId) {
    console.warn(`  intent "${text}" routed to ${r.quorumId ?? 'demand board'}, expected ${quorumId}`);
    return;
  }
  const start = await startCheckout(quorumId, { email, intentId: r.intent.id, provider: 'mock' });
  mockPayPal.approve(start.orderId, email);
  await completeAuthorization(quorumId, start.orderId);
}

await simulatedMember(groupA.id, 'Compact espresso machine for two, under $200', 'ana.demo@example.com');
await simulatedMember(groupA.id, 'small espresso maker with milk frother', 'luis.demo@example.com');
await simulatedMember(groupA.id, 'Cafetera espresso compacta, menos de 200 dólares', 'sofia.demo@example.com');
await simulatedMember(groupA.id, 'latte machine for my apartment, max $199', 'mateo.demo@example.com');
await simulatedMember(groupB.id, 'gooseneck kettle for pour over', 'carla.demo@example.com');
await simulatedMember(groupB.id, 'hervidor eléctrico cuello de cisne', 'diego.demo@example.com');

// Demand with no matching product yet: shows up on the merchant demand board.
for (const t of [
  'Standing desk with electric height adjustment under $300',
  'electric standing desk, max $280, before December',
  'Escritorio elevable eléctrico, hasta 300 dólares',
  'Noise cancelling headphones under $150',
  'wireless noise-cancelling headphones, less than $140',
]) {
  await submitIntent(t, null);
}

// Spread the seeded authorizations over the last few hours so the page feels real.
run("UPDATE commitments SET authorized_at = datetime('now', '-' || (abs(random()) % 300) || ' minutes') WHERE provider = 'mock'");

console.log('Seeded demo data:');
console.log(`  Group A (4 of 5, espresso):  ${config.baseUrl}/q/${groupA.id}`);
console.log(`  Group B (2 of 5, expiring):  ${config.baseUrl}/q/${groupB.id}`);
console.log(`  Merchant console:            ${config.baseUrl}/merchant`);
