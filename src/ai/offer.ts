// Pricing agent for merchants. It turns a cluster of unmet demand into a draft
// group offer: a list price, public volume tiers and a suggested floor.
// The agent reads what buyers said they would pay and live comparable offers
// (Channel3). Code then repairs the draft so it always obeys the pricing
// rules, and the merchant reviews it before anything is published.
import type { MarketOffer } from '../models.ts';
import { logAgent } from '../events.ts';
import { round2 } from '../util.ts';
import { marketSearch } from './catalog.ts';
import type { DemandCluster } from './intent.ts';
import { CATEGORIES } from './intent.ts';
import { DATA_RULE, fence, structured } from './llm.ts';

export type OfferDraft = {
  title: string;
  category: string;
  description: string;
  keywords: string;
  listPrice: number;
  floorPrice: number;
  tiers: { min: number; price: number }[];
  hours: number;
  rationale: string;
  market: MarketOffer[];
  reach: number; // waiting requests that can afford the goal price
  engine: 'llm' | 'heuristic';
};

const whole = (n: number) => Math.max(1, Math.round(n));

/** Offers that sit near what these buyers are willing to pay. */
function nearBudget(offers: MarketOffer[], budget: number | null): MarketOffer[] {
  const band = budget ? offers.filter((o) => o.price >= budget * 0.5 && o.price <= budget * 1.8) : offers;
  return [...band].sort((a, b) => a.price - b.price).slice(0, 5);
}

/** How many waiting requests could pay `price` (requests without a stated maximum count as able). */
const canAfford = (maxes: (number | null)[], price: number) => maxes.filter((m) => m === null || m >= price).length;

type RawPrices = { listPrice: number; floorPrice: number; tiers: { min: number; price: number }[] };

/**
 * Enforce the pricing rules on any draft, whoever wrote it:
 * list > goal tier, tiers fall as volume grows, floor <= cheapest tier,
 * and the goal is small enough that the people already waiting can reach it.
 */
export function repairDraft(raw: RawPrices, cluster: Pick<DemandCluster, 'count' | 'medianMax'>): RawPrices {
  const budget = cluster.medianMax;
  let tiers = (Array.isArray(raw.tiers) ? raw.tiers : [])
    .map((t) => ({ min: Math.floor(Number(t.min)), price: Number(t.price) }))
    .filter((t) => Number.isFinite(t.min) && Number.isFinite(t.price) && t.min >= 2 && t.price > 0)
    .sort((a, b) => a.min - b.min)
    .slice(0, 3);
  if (!tiers.length) tiers = [{ min: Math.max(2, cluster.count), price: budget ? budget * 0.95 : (Number(raw.listPrice) || 100) * 0.9 }];
  // The goal must be reachable by the demand that already exists.
  tiers[0].min = Math.max(2, Math.min(tiers[0].min, Math.max(2, cluster.count)));
  // The goal price must be within the typical buyer's stated maximum.
  if (budget && tiers[0].price > budget) tiers[0].price = budget;
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].min <= tiers[i - 1].min) tiers[i].min = tiers[i - 1].min + 2;
    if (tiers[i].price >= tiers[i - 1].price) tiers[i].price = tiers[i - 1].price * 0.95;
  }
  tiers = tiers.map((t) => ({ min: t.min, price: whole(t.price) }));
  for (let i = 1; i < tiers.length; i++) if (tiers[i].price >= tiers[i - 1].price) tiers[i].price = Math.max(1, tiers[i - 1].price - 1);
  const cheapest = tiers[tiers.length - 1].price;
  let listPrice = whole(Number(raw.listPrice) || tiers[0].price * 1.12);
  if (listPrice <= tiers[0].price) listPrice = Math.max(tiers[0].price + 1, whole(tiers[0].price * 1.1));
  let floorPrice = whole(Number(raw.floorPrice) || cheapest * 0.85);
  if (floorPrice > cheapest) floorPrice = cheapest;
  return { listPrice, floorPrice: round2(floorPrice), tiers };
}

function heuristicDraft(cluster: DemandCluster, market: MarketOffer[]) {
  const budget = cluster.medianMax ?? (market.length ? market[Math.floor(market.length / 2)].price : 100);
  const goal = budget * 0.95;
  const goalSize = Math.max(2, cluster.count);
  return {
    title: cluster.label.replace(/\b\w/, (c) => c.toUpperCase()),
    description: `Opened for ${cluster.count} ${cluster.count === 1 ? 'buyer' : 'buyers'} who asked for: ${cluster.label}.`,
    keywords: cluster.label,
    listPrice: market.length ? Math.max(budget * 1.1, market[0].price) : budget * 1.12,
    floorPrice: goal * 0.8,
    tiers: [
      { min: goalSize, price: goal },
      { min: goalSize * 2, price: goal * 0.93 },
    ],
    rationale:
      `${cluster.count} ${cluster.count === 1 ? 'request is' : 'requests are'} waiting` +
      (cluster.medianMax ? ` with a median maximum of $${cluster.medianMax}` : '') +
      '. The goal price sits just under that maximum so they can all join' +
      (market.length ? `; comparable offers start at $${market[0].price} (${market[0].merchant}).` : '.') +
      ' Set the floor from your own cost before publishing.',
  };
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Product title a merchant would list, under 80 characters' },
    description: { type: 'string', description: 'One sentence describing the product these buyers want' },
    keywords: { type: 'string', description: 'Comma-separated search keywords, English and Spanish' },
    list_price: { type: 'number', description: 'Price for one buyer alone, USD' },
    floor_price: { type: 'number', description: 'Suggested lowest price the merchant should accept, USD' },
    tiers: {
      type: 'array',
      description: 'Two volume tiers, cheapest for the larger group',
      items: { type: 'object', properties: { min: { type: 'integer' }, price: { type: 'number' } }, required: ['min', 'price'] },
    },
    rationale: { type: 'string', description: 'Two sentences a merchant can read: why these prices, citing the demand and market data' },
  },
  required: ['title', 'description', 'keywords', 'list_price', 'floor_price', 'tiers', 'rationale'],
};

type LlmDraft = {
  title: string;
  description: string;
  keywords: string;
  list_price: number;
  floor_price: number;
  tiers: { min: number; price: number }[];
  rationale: string;
};

/** Draft a group offer for a demand cluster. Returns numbers that already obey the pricing rules. */
export async function draftOffer(cluster: DemandCluster, maxes: (number | null)[]): Promise<OfferDraft> {
  const market = nearBudget(await marketSearch(cluster.label, { limit: 12 }), cluster.medianMax);
  const base = heuristicDraft(cluster, market);
  const llm = await structured<LlmDraft>({
    system:
      'You are a pricing agent for a merchant on a group-buying marketplace. Buyers commit first; the merchant sells only if the group forms. ' +
      'Propose a list price (one buyer alone), two volume tiers, and a floor. The first tier is the group goal: its size must not exceed the number of waiting requests, ' +
      "and its price must be at or below the median maximum buyers stated. Stay competitive with the market offers. You do not know the merchant's cost, so say the floor is a suggestion. " +
      DATA_RULE,
    prompt: [
      fence(
        'demand',
        `${cluster.count} waiting requests in category "${cluster.category}". Median maximum price: ${cluster.medianMax ?? 'not stated'}. Earliest deadline: ${cluster.earliestDeadline ?? 'none'}.\n${cluster.samples.map((s) => `- ${s}`).join('\n')}`,
      ),
      fence('market', market.length ? market.map((m) => `${m.title} — $${m.price} at ${m.merchant}`).join('\n') : 'No market data available.'),
      'Draft the offer.',
    ].join('\n'),
    schema: DRAFT_SCHEMA,
  });
  const source = llm
    ? { title: llm.title, description: llm.description, keywords: llm.keywords, listPrice: llm.list_price, floorPrice: llm.floor_price, tiers: llm.tiers, rationale: llm.rationale }
    : base;
  const prices = repairDraft(source, cluster);
  const draft: OfferDraft = {
    title: String(source.title || base.title).slice(0, 120),
    category: (CATEGORIES as readonly string[]).includes(cluster.category) ? cluster.category : 'other',
    description: String(source.description || base.description).slice(0, 600),
    keywords: String(source.keywords || base.keywords).slice(0, 300),
    ...prices,
    hours: 72,
    rationale: String(source.rationale || base.rationale).slice(0, 600),
    market,
    reach: canAfford(maxes, prices.tiers[0].price),
    engine: llm ? 'llm' : 'heuristic',
  };
  logAgent(
    'pricing',
    null,
    `drafted offer for "${cluster.label}"`,
    `goal ${draft.tiers[0].min} buyers at $${draft.tiers[0].price}; ${draft.reach} of ${cluster.count} waiting requests can afford it`,
    draft.engine,
  );
  return draft;
}
