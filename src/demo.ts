// Demo data, and keeping a hosted demo usable for weeks.
//
// seedDemo() creates two fictional merchants, a catalog, two open groups and
// some waiting demand. Seeded buyers use simulated PayPal (provider "mock"),
// so the demo works without sandbox accounts; real buyers use PayPal sandbox.
//
// Groups close after two days, and a visitor who walks through the demo uses
// it up. With DEMO_AUTO_RESET=true the server puts the demo back to its
// starting state once it is used up (or expired) and nobody is using it.
import { config } from './config.ts';
import { all, get, run, tx } from './db.ts';
import { createMerchant, createProduct, createQuorum, getProduct, authorizedCount, type Quorum } from './models.ts';
import { completeAuthorization, startCheckout } from './engine.ts';
import { mockPayPal } from './paypal/index.ts';
import { marketFor } from './ai/catalog.ts';
import { demandBoard, ensureProductEmbedding, submitIntent } from './ai/intent.ts';

const ESPRESSO = 'Compact 15-bar espresso machine';

export async function seedDemo(opts: { llm?: boolean } = {}): Promise<{ groupA: Quorum; groupB: Quorum }> {
  // Seeding must give the same demo every time, so the sample requests are routed by
  // rules, not by the model. (Real requests typed into the app still use Claude.)
  const key = config.anthropic.apiKey;
  if (!opts.llm) config.anthropic.apiKey = '';
  try {
    const cafe = createMerchant('Café Altura', null);
    const trail = createMerchant('Trailhead Supply', null);

    const products = [
      createProduct({
        merchantId: cafe.id,
        title: ESPRESSO,
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

    const simulatedMember = async (quorumId: string, text: string, email: string) => {
      const r = await submitIntent(text, email);
      if (r.quorumId !== quorumId) {
        console.warn(`  intent "${text}" routed to ${r.quorumId ?? 'demand board'}, expected ${quorumId}`);
        return;
      }
      const start = await startCheckout(quorumId, { email, intentId: r.intent.id, provider: 'mock' });
      mockPayPal.approve(start.orderId, email);
      await completeAuthorization(quorumId, start.orderId);
    };

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
    return { groupA, groupB };
  } finally {
    config.anthropic.apiKey = key;
  }
}

const TABLES = ['notifications', 'agent_log', 'events', 'payouts', 'negotiations', 'commitments', 'intents', 'mock_paypal', 'quorums', 'products', 'merchants'];

/** Why the demo no longer matches what the judges' instructions describe, or null when it does. */
export function demoStaleness(): string | null {
  if (!get('SELECT id FROM merchants LIMIT 1')) return 'empty database';
  const open = all<Quorum>(
    `SELECT q.* FROM quorums q JOIN products p ON p.id = q.product_id
     WHERE p.title = ? AND q.status = 'open' AND q.closes_at > ?`,
    ESPRESSO, new Date(Date.now() + 2 * 3600_000).toISOString(),
  );
  if (!open.some((q) => authorizedCount(q.id) < q.min_members)) return 'no open espresso group that still needs a buyer';
  if (!demandBoard().some((c) => c.count >= 3)) return 'the demand board was used';
  return null;
}

/** When something last happened: a request, a payment step, an agent decision. */
function lastActivity(): number {
  let last = 0;
  for (const t of ['events', 'agent_log', 'commitments', 'intents', 'quorums']) {
    const row = get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM ${t}`);
    if (row?.at) last = Math.max(last, Date.parse(row.at.includes('T') ? row.at : row.at.replace(' ', 'T') + 'Z'));
  }
  return last;
}

let resetting = false;

/**
 * Put the demo back to its starting state when it is used up or expired, but
 * only if nobody is in the middle of something: no activity for `idleMinutes`,
 * and no real PayPal authorization still being held for a buyer.
 */
export async function keepDemoFresh(idleMinutes = Number(process.env.DEMO_RESET_IDLE_MINUTES ?? 45)): Promise<string | null> {
  if (resetting) return null;
  const why = demoStaleness();
  if (!why) return null;
  if (why !== 'empty database') {
    if (Date.now() - lastActivity() < idleMinutes * 60_000) return null;
    if (get("SELECT id FROM commitments WHERE provider = 'paypal' AND status = 'authorized' LIMIT 1")) return null;
  }
  resetting = true;
  try {
    tx(() => {
      for (const t of TABLES) run(`DELETE FROM ${t}`);
    });
    await seedDemo();
    console.log(`[demo] reset to the starting state (${why})`);
    return why;
  } finally {
    resetting = false;
  }
}
