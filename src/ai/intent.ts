// Intent agent: understands a free-text purchase request, then groups it with
// compatible demand. Hard filters run in code; the LLM only confirms fit.
import { config, hasLLM } from '../config.ts';
import { all, run } from '../db.ts';
import { logAgent } from '../events.ts';
import {
  createQuorum,
  getProduct,
  listProducts,
  listQuorums,
  tiersOf,
  authorizedCount,
  type Intent,
  type Product,
  type Quorum,
} from '../models.ts';
import { authorizationAmount, minMembers, priceFor } from '../pricing.ts';
import { newId, nowIso, safeJson } from '../util.ts';
import { marketSearch } from './catalog.ts';
import { embed, normalizeText, similarity, type Embedding } from './embed.ts';
import { DATA_RULE, fence, structured } from './llm.ts';

export const CATEGORIES = ['coffee', 'kitchen', 'outdoor', 'audio', 'electronics', 'home', 'fitness', 'fashion', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ParsedIntent = {
  product_query: string;
  category: Category;
  must_have: string[];
  nice_to_have: string[];
  max_price: number | null;
  deadline: string | null; // ISO date
  quantity: number;
};

const CATEGORY_WORDS: Record<Category, string[]> = {
  coffee: ['coffee', 'espresso', 'grinder', 'latte', 'barista', 'moka', 'french press', 'cafetera', 'molinillo', 'cafe'],
  kitchen: ['kettle', 'blender', 'air fryer', 'knife', 'pan', 'pot', 'toaster', 'hervidor', 'licuadora', 'freidora', 'olla', 'sarten'],
  outdoor: ['tent', 'camping', 'sleeping bag', 'hiking', 'backpack', 'trail', 'bottle', 'carpa', 'mochila', 'botella', 'termo', 'trekking'],
  audio: ['headphones', 'earbuds', 'speaker', 'headset', 'audifonos', 'auriculares', 'parlante', 'altavoz'],
  electronics: ['laptop', 'monitor', 'keyboard', 'mouse', 'tablet', 'phone', 'charger', 'webcam', 'teclado', 'cargador'],
  home: ['lamp', 'chair', 'desk', 'vacuum', 'pillow', 'sofa', 'lampara', 'silla', 'escritorio', 'aspiradora'],
  fitness: ['yoga', 'dumbbell', 'treadmill', 'bike', 'running', 'mat', 'pesas', 'bicicleta'],
  fashion: ['shoes', 'jacket', 'sneakers', 'shirt', 'dress', 'zapatillas', 'chaqueta', 'polera'],
  other: [],
};

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

export function guessCategory(text: string): Category {
  const t = ` ${text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
  let best: Category = 'other';
  let score = 0;
  for (const cat of CATEGORIES) {
    const s = CATEGORY_WORDS[cat].filter((w) => t.includes(w)).length;
    if (s > score) {
      score = s;
      best = cat;
    }
  }
  return best;
}

export function parsePrice(text: string): number | null {
  const t = text.toLowerCase().replace(/,(\d{3})/g, '$1');
  const patterns = [
    /(?:under|below|less than|max(?:imum)?|up to|no more than|menos de|hasta|por debajo de|m[aá]ximo|<)\s*(?:us)?\$?\s*(\d+(?:[.,]\d{1,2})?)/,
    /\$\s*(\d+(?:[.,]\d{1,2})?)/,
    /(\d+(?:[.,]\d{1,2})?)\s*(?:usd|dollars|bucks|d[oó]lares)/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return Number(m[1].replace(',', '.'));
  }
  return null;
}

export function parseDeadline(text: string, now = new Date()): string | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const rel = t.match(/(?:in|within|en|dentro de)\s+(\d+)\s*(day|days|dia|dias|week|weeks|semana|semanas)/);
  if (rel) {
    const n = Number(rel[1]) * (rel[2].startsWith('w') || rel[2].startsWith('s') ? 7 : 1);
    return new Date(now.getTime() + n * 86400_000).toISOString().slice(0, 10);
  }
  const m = t.match(/(?:before|by|until|antes de|para|hasta)\s+(?:el\s+|la\s+)?(?:fin de\s+|end of\s+)?([a-z]+)/);
  if (m && MONTHS[m[1]] !== undefined) {
    const month = MONTHS[m[1]];
    let year = now.getUTCFullYear();
    if (month < now.getUTCMonth()) year += 1;
    return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  }
  return null;
}

export function heuristicParse(text: string): ParsedIntent {
  const tokens = normalizeText(text);
  return {
    product_query: tokens.slice(0, 8).join(' ') || text.slice(0, 60),
    category: guessCategory(text),
    must_have: [...new Set(tokens)].slice(0, 6),
    nice_to_have: [],
    max_price: parsePrice(text),
    deadline: parseDeadline(text),
    quantity: 1,
  };
}

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    product_query: { type: 'string', description: 'Short English product search query, 2-8 words' },
    category: { type: 'string', enum: [...CATEGORIES] },
    must_have: { type: 'array', items: { type: 'string' }, description: 'Hard requirements, short English phrases' },
    nice_to_have: { type: 'array', items: { type: 'string' } },
    max_price: { type: ['number', 'null'], description: 'Maximum price per unit in USD, null if not stated' },
    deadline: { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD) the buyer needs it by, null if not stated' },
    quantity: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['product_query', 'category', 'must_have', 'nice_to_have', 'max_price', 'deadline', 'quantity'],
};

export async function parseIntent(text: string): Promise<{ parsed: ParsedIntent; engine: string }> {
  const llm = await structured<ParsedIntent>({
    system: `You turn a shopper's free-text request (English or Spanish) into a structured purchase intent. Today is ${nowIso().slice(0, 10)}. ${DATA_RULE}`,
    prompt: `Extract the intent from this request.\n${fence('buyer_request', text)}`,
    schema: PARSE_SCHEMA,
    fast: true,
  });
  const heuristic = heuristicParse(text);
  if (!llm) return { parsed: heuristic, engine: 'heuristic' };
  // Code-side sanity: prices and dates the model reports must be plausible.
  const parsed: ParsedIntent = {
    product_query: String(llm.product_query || heuristic.product_query).slice(0, 80),
    category: (CATEGORIES as readonly string[]).includes(llm.category) ? llm.category : heuristic.category,
    must_have: (llm.must_have ?? []).slice(0, 8).map(String),
    nice_to_have: (llm.nice_to_have ?? []).slice(0, 8).map(String),
    max_price: typeof llm.max_price === 'number' && llm.max_price > 0 && llm.max_price < 100000 ? llm.max_price : heuristic.max_price,
    deadline: llm.deadline && /^\d{4}-\d{2}-\d{2}$/.test(llm.deadline) ? llm.deadline : heuristic.deadline,
    quantity: Math.min(10, Math.max(1, Math.floor(llm.quantity || 1))),
  };
  return { parsed, engine: 'llm' };
}

const intentText = (p: ParsedIntent, raw: string) => `${p.product_query}. ${p.must_have.join(', ')}. ${raw}`;
const productText = (p: Product) => `${p.title}. ${p.category}. ${p.keywords}. ${p.description}`;
const productEmbedding = (p: Product): Embedding | null => safeJson<Embedding | null>(p.embedding_json, null);

/** Does this product satisfy the hard constraints in code (no AI involved)? */
export function hardFit(parsed: ParsedIntent, product: Product, quorum?: Quorum): { ok: boolean; why: string } {
  if (parsed.category !== 'other' && product.category !== parsed.category) return { ok: false, why: 'different category' };
  const tiers = tiersOf(product);
  if (authorizationAmount(tiers, parsed.max_price) === null) {
    return { ok: false, why: `group price ${priceFor(tiers, minMembers(tiers))} is above the buyer's max ${parsed.max_price}` };
  }
  if (quorum && parsed.deadline && quorum.closes_at.slice(0, 10) > parsed.deadline) {
    return { ok: false, why: 'group closes after the buyer deadline' };
  }
  return { ok: true, why: 'fits price, category and deadline' };
}

type Candidate = { product: Product; quorum?: Quorum; score: number };

async function confirmFit(raw: string, parsed: ParsedIntent, c: Candidate, others: string[]) {
  const answer = await structured<{ fits: boolean; reason: string }>({
    system: `You check whether a shopper would accept a specific product as fulfilling their request. Be strict about stated requirements; ignore price (checked elsewhere). ${DATA_RULE}`,
    prompt: [
      fence('buyer_request', raw),
      fence('product', `${c.product.title}\n${c.product.description}\nKeywords: ${c.product.keywords}`),
      others.length ? fence('group_members_requests', others.slice(0, 5).join('\n')) : '',
      'Would this buyer accept this product? Answer with fits=true/false and a one-sentence reason a shopper can read.',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: { fits: { type: 'boolean' }, reason: { type: 'string' } },
      required: ['fits', 'reason'],
    },
    fast: true,
  });
  return answer;
}

export const SIMILARITY_THRESHOLD = 0.2;

export type RouteResult = {
  intent: Intent;
  outcome: 'joined' | 'opened' | 'waiting';
  quorumId: string | null;
  explanation: string;
  engine: string;
};

/** Parse, store and route an intent to an open group, a new group, or the demand board. */
export async function submitIntent(text: string, email: string | null): Promise<RouteResult> {
  const { parsed, engine } = await parseIntent(text);
  const iText = intentText(parsed, text);
  const emb = await embed(iText);

  // 1) Open groups first: joining beats opening, because it grows an existing group.
  const open = listQuorums('open');
  const candidates: Candidate[] = [];
  for (const q of open) {
    const product = getProduct(q.product_id)!;
    if (!hardFit(parsed, product, q).ok) continue;
    const score = similarity(iText, emb, productText(product), productEmbedding(product));
    if (score >= SIMILARITY_THRESHOLD) candidates.push({ product, quorum: q, score });
  }
  // 2) Then catalog products that have no open group yet.
  const withOpenGroup = new Set(open.map((q) => q.product_id));
  const fresh: Candidate[] = [];
  for (const product of listProducts()) {
    if (withOpenGroup.has(product.id) || !hardFit(parsed, product).ok) continue;
    const score = similarity(iText, emb, productText(product), productEmbedding(product));
    if (score >= SIMILARITY_THRESHOLD) fresh.push({ product, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  fresh.sort((a, b) => b.score - a.score);

  let chosen: Candidate | null = null;
  let reason = '';
  let decisionEngine = hasLLM() ? 'llm' : 'heuristic';
  for (const c of [...candidates.slice(0, 3), ...fresh.slice(0, 3)]) {
    const others = c.quorum
      ? all<{ text: string }>('SELECT text FROM intents WHERE quorum_id = ? ORDER BY created_at DESC LIMIT 5', c.quorum.id).map((r) => r.text)
      : [];
    const verdict = await confirmFit(text, parsed, c, others);
    if (verdict) {
      logAgent('intent', c.quorum?.id ?? c.product.id, verdict.fits ? 'fit' : 'no-fit', verdict.reason, 'llm');
      if (verdict.fits) {
        chosen = c;
        reason = verdict.reason;
        break;
      }
    } else {
      decisionEngine = 'heuristic';
      chosen = c; // heuristic: best candidate that passed hard filters and similarity
      reason = `Matched on "${parsed.product_query}" (similarity ${c.score.toFixed(2)}), within your price and timing.`;
      break;
    }
  }

  const id = newId('int');
  const insert = (quorumId: string | null, status: Intent['status'], why: string) =>
    run(
      `INSERT INTO intents (id, email, text, parsed_json, category, max_price, deadline, embedding_json, quorum_id, status, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, email, text, JSON.stringify(parsed), parsed.category, parsed.max_price, parsed.deadline, JSON.stringify(emb), quorumId, status, why, nowIso(),
    );

  if (!chosen) {
    const why = 'No group or product fits yet. Your request is on the demand board, where merchants see grouped demand before they stock.';
    insert(null, 'waiting', why);
    logAgent('intent', id, 'waiting', why, decisionEngine);
    return { intent: getIntentRow(id), outcome: 'waiting', quorumId: null, explanation: why, engine };
  }

  let quorum = chosen.quorum;
  let outcome: RouteResult['outcome'] = 'joined';
  if (!quorum) {
    quorum = createQuorum(chosen.product, config.quorum.hours, `Group for: ${parsed.product_query}`);
    outcome = 'opened';
    // Market check for the new group (Channel3). Empty when no key is set.
    const market = await marketSearch(chosen.product.title, { limit: 5 });
    run('UPDATE quorums SET market_json = ? WHERE id = ?', JSON.stringify(market), quorum.id);
    attachWaitingIntents(quorum.id, chosen.product);
  }
  insert(quorum.id, 'grouped', reason);
  logAgent('intent', quorum.id, `${outcome === 'opened' ? 'opened group for' : 'grouped'} "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`, reason, decisionEngine);
  const peers = all<{ n: number }>('SELECT COUNT(*) AS n FROM intents WHERE quorum_id = ?', quorum.id)[0].n;
  const committed = authorizedCount(quorum.id);
  const explanation =
    `${peers} ${peers === 1 ? 'person is' : 'people are'} looking for ${parsed.product_query}` +
    `${committed ? `; ${committed} already committed` : ''}. ${reason}`;
  return { intent: getIntentRow(id), outcome, quorumId: quorum.id, explanation, engine };
}

const getIntentRow = (id: string) => all<Intent>('SELECT * FROM intents WHERE id = ?', id)[0];

/** When a group opens, pull in compatible requests that were waiting on the demand board. */
export function attachWaitingIntents(quorumId: string, product: Product): number {
  const waiting = all<Intent>("SELECT * FROM intents WHERE status = 'waiting'");
  let n = 0;
  for (const it of waiting) {
    const parsed = safeJson<ParsedIntent>(it.parsed_json, heuristicParse(it.text));
    if (!hardFit(parsed, product).ok) continue;
    const score = similarity(intentText(parsed, it.text), safeJson<Embedding | null>(it.embedding_json, null), productText(product), productEmbedding(product));
    if (score < SIMILARITY_THRESHOLD) continue;
    run("UPDATE intents SET quorum_id = ?, status = 'grouped', reason = ? WHERE id = ?", quorumId, 'A merchant opened a group that matches your request.', it.id);
    n++;
  }
  return n;
}

export type DemandCluster = {
  label: string;
  category: string;
  count: number;
  medianMax: number | null;
  earliestDeadline: string | null;
  samples: string[];
  intentIds: string[];
};

/** Group waiting intents so merchants see demand before supply exists. */
export function demandBoard(): DemandCluster[] {
  const waiting = all<Intent>("SELECT * FROM intents WHERE status = 'waiting' ORDER BY created_at");
  const clusters: { seed: Intent; items: Intent[] }[] = [];
  for (const it of waiting) {
    const pe = safeJson<ParsedIntent>(it.parsed_json, heuristicParse(it.text));
    const emb = safeJson<Embedding | null>(it.embedding_json, null);
    let home = clusters.find((c) => {
      const sp = safeJson<ParsedIntent>(c.seed.parsed_json, heuristicParse(c.seed.text));
      return (
        sp.category === pe.category &&
        similarity(intentText(pe, it.text), emb, intentText(sp, c.seed.text), safeJson<Embedding | null>(c.seed.embedding_json, null)) >= 0.3
      );
    });
    if (!home) clusters.push((home = { seed: it, items: [] }));
    home.items.push(it);
  }
  return clusters
    .map((c) => {
      const maxes = c.items.map((i) => i.max_price).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
      const deadlines = c.items.map((i) => i.deadline).filter((x): x is string => !!x).sort();
      const seedParsed = safeJson<ParsedIntent>(c.seed.parsed_json, heuristicParse(c.seed.text));
      return {
        label: seedParsed.product_query,
        category: seedParsed.category,
        count: c.items.length,
        medianMax: maxes.length ? maxes[Math.floor(maxes.length / 2)] : null,
        earliestDeadline: deadlines[0] ?? null,
        samples: c.items.slice(0, 3).map((i) => i.text),
        intentIds: c.items.map((i) => i.id),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Pre-compute product embeddings (for products created by seed or merchant console). */
export async function ensureProductEmbedding(p: Product) {
  if (p.embedding_json) return;
  const e = await embed(productText(p));
  run('UPDATE products SET embedding_json = ? WHERE id = ?', JSON.stringify(e), p.id);
}
