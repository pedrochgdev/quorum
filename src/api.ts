// JSON API.
import { config, describeModes, isMockPayPal } from './config.ts';
import { all, run } from './db.ts';
import { agentLogFor, recentEvents } from './events.ts';
import { HttpError, readJson, rateLimit, route, sendJson, type Ctx } from './http.ts';
import {
  createProduct,
  createQuorum,
  getCommitment,
  getProduct,
  getQuorum,
  listMerchants,
  listProducts,
  listQuorums,
  quorumView,
  tiersOf,
  type Product,
} from './models.ts';
import { normalizeTiers, type Tier } from './pricing.ts';
import { addSimulatedBuyer, completeAuthorization, settleDue, settleQuorum, startCheckout } from './engine.ts';
import { attachWaitingIntents, CATEGORIES, demandBoard, ensureProductEmbedding, submitIntent } from './ai/intent.ts';
import { inviteFor } from './ai/growth.ts';
import { marketSearch } from './ai/catalog.ts';
import { mockPayPal } from './paypal/index.ts';
import { handlePayPalWebhook } from './paypal/webhooks.ts';
import { isEmail, nowIso } from './util.ts';

const isAdmin = (ctx: Ctx) =>
  config.demoAdmin || (config.cronSecret && ctx.req.headers.authorization === `Bearer ${config.cronSecret}`);

function requireAdmin(ctx: Ctx) {
  if (!isAdmin(ctx)) throw new HttpError(403, 'Admin actions are disabled (set DEMO_ADMIN=true for demos)');
}

function requireMerchant(ctx: Ctx) {
  const token = process.env.MERCHANT_TOKEN;
  if (!token) return;
  const given = ctx.req.headers['x-merchant-token'] ?? ctx.url.searchParams.get('token');
  if (given !== token) throw new HttpError(401, 'Merchant token required');
}

const quorumOr404 = (id: string) => {
  const q = getQuorum(id);
  if (!q) throw new HttpError(404, 'Group not found');
  return q;
};

export function registerApi() {
  route('GET', '/api/health', ({ res }) => sendJson(res, 200, { ok: true, modes: describeModes(), time: nowIso() }));

  route('POST', '/api/intents', async (ctx) => {
    rateLimit(ctx.req, 'intents', 20);
    const body = await readJson<{ text?: string; email?: string }>(ctx.req);
    const text = String(body.text ?? '').trim();
    if (text.length < 3 || text.length > 500) throw new HttpError(400, 'Describe what you want in 3 to 500 characters');
    const email = body.email && isEmail(body.email) ? body.email.trim() : null;
    const result = await submitIntent(text, email);
    sendJson(ctx.res, 200, {
      intentId: result.intent.id,
      outcome: result.outcome,
      quorumId: result.quorumId,
      explanation: result.explanation,
      parsed: JSON.parse(result.intent.parsed_json),
      engine: result.engine,
    });
  });

  route('GET', '/api/quorums', ({ res }) => {
    const views = listQuorums().slice(0, 50).map(quorumView);
    sendJson(res, 200, { quorums: views });
  });

  route('GET', '/api/quorums/:id', (ctx) => {
    const q = quorumOr404(ctx.params.id);
    sendJson(ctx.res, 200, { quorum: quorumView(q), agentLog: agentLogFor(q.id), admin: Boolean(isAdmin(ctx)) });
  });

  route('POST', '/api/quorums/:id/checkout', async (ctx) => {
    rateLimit(ctx.req, 'checkout', 30);
    quorumOr404(ctx.params.id);
    const body = await readJson<{ email?: string; intentId?: string; ref?: string }>(ctx.req);
    if (!isEmail(body.email)) throw new HttpError(400, 'Enter a valid email so we can tell you when the group closes');
    const out = await startCheckout(ctx.params.id, { email: body.email, intentId: body.intentId || null, referrerId: body.ref || null });
    sendJson(ctx.res, 200, out);
  });

  route('POST', '/api/quorums/:id/authorize', async (ctx) => {
    const body = await readJson<{ orderId?: string }>(ctx.req);
    if (!body.orderId) throw new HttpError(400, 'orderId is required');
    const c = await completeAuthorization(ctx.params.id, body.orderId);
    sendJson(ctx.res, 200, { commitmentId: c.id, status: c.status, quorum: quorumView(getQuorum(ctx.params.id)!) });
  });

  route('POST', '/api/quorums/:id/invite', async (ctx) => {
    rateLimit(ctx.req, 'invite', 20);
    const q = quorumOr404(ctx.params.id);
    const body = await readJson<{ commitmentId?: string }>(ctx.req);
    const c = body.commitmentId ? getCommitment(body.commitmentId) : undefined;
    sendJson(ctx.res, 200, await inviteFor(quorumView(q), c && c.quorum_id === q.id ? c.id : null));
  });

  // ---- Admin / demo controls -------------------------------------------------
  route('POST', '/api/quorums/:id/settle', async (ctx) => {
    requireAdmin(ctx);
    quorumOr404(ctx.params.id);
    run('UPDATE quorums SET closes_at = ? WHERE id = ? AND status = ?', nowIso(), ctx.params.id, 'open');
    const out = await settleQuorum(ctx.params.id, { force: true });
    sendJson(ctx.res, 200, { outcome: out, quorum: quorumView(getQuorum(ctx.params.id)!) });
  });

  route('POST', '/api/quorums/:id/simulate-buyer', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson<{ email?: string; ref?: string }>(ctx.req);
    const n = all('SELECT id FROM commitments WHERE quorum_id = ?', ctx.params.id).length + 1;
    const email = isEmail(body.email) ? body.email : `demo.buyer${n}@example.com`;
    const c = await addSimulatedBuyer(ctx.params.id, email, body.ref || null);
    sendJson(ctx.res, 200, { commitmentId: c.id, quorum: quorumView(getQuorum(ctx.params.id)!) });
  });

  route('GET', '/api/cron/settle', cron);
  route('POST', '/api/cron/settle', cron);

  route('GET', '/api/events', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { events: recentEvents(100) });
  });

  // ---- PayPal ------------------------------------------------------------------
  route('POST', '/api/webhooks/paypal', async (ctx) => {
    const event = await readJson(ctx.req, 256 * 1024);
    const out = await handlePayPalWebhook(ctx.req.headers as Record<string, string>, event);
    sendJson(ctx.res, out.ok ? 200 : 400, out);
  });

  route('POST', '/api/mock-paypal/approve', async (ctx) => {
    if (!isMockPayPal()) throw new HttpError(404, 'Not found');
    const body = await readJson<{ orderId?: string; email?: string }>(ctx.req);
    if (!body.orderId) throw new HttpError(400, 'orderId is required');
    mockPayPal.approve(body.orderId, isEmail(body.email) ? body.email : 'buyer@example.com');
    sendJson(ctx.res, 200, { ok: true });
  });

  // ---- Merchant console ----------------------------------------------------------
  route('GET', '/api/merchant', (ctx) => {
    requireMerchant(ctx);
    sendJson(ctx.res, 200, {
      merchants: listMerchants(),
      products: listProducts(false).map((p) => productView(p)),
      quorums: listQuorums().slice(0, 50).map(quorumView),
      demand: demandBoard(),
      categories: CATEGORIES,
    });
  });

  route('POST', '/api/merchant/products', async (ctx) => {
    requireMerchant(ctx);
    const b = await readJson<any>(ctx.req);
    const merchantId = String(b.merchantId ?? listMerchants()[0]?.id ?? '');
    if (!merchantId) throw new HttpError(400, 'Create a merchant first (npm run seed)');
    const listPrice = Number(b.listPrice);
    const floorPrice = Number(b.floorPrice);
    const title = String(b.title ?? '').trim();
    if (!title || title.length > 120) throw new HttpError(400, 'Title is required (max 120 characters)');
    validatePrices(listPrice, floorPrice);
    const category = (CATEGORIES as readonly string[]).includes(b.category) ? b.category : 'other';
    const tiers = cleanTiers(b.tiers, listPrice, floorPrice);
    const p = createProduct({
      merchantId,
      title,
      category,
      description: String(b.description ?? '').slice(0, 600),
      keywords: String(b.keywords ?? '').slice(0, 300),
      imageUrl: null,
      listPrice,
      floorPrice,
      stock: Math.max(0, Math.floor(Number(b.stock) || 0)),
      tiers,
    });
    await ensureProductEmbedding(p);
    let quorumId: string | null = null;
    let attached = 0;
    if (b.openGroup) {
      const q = createQuorum(getProduct(p.id)!, Number(b.hours) > 0 ? Number(b.hours) : config.quorum.hours, `Opened by ${listMerchants().find((m) => m.id === merchantId)?.name ?? 'merchant'} from the demand board`);
      const market = await marketSearch(p.title, { limit: 5 });
      run('UPDATE quorums SET market_json = ? WHERE id = ?', JSON.stringify(market), q.id);
      attached = attachWaitingIntents(q.id, getProduct(p.id)!);
      quorumId = q.id;
    }
    sendJson(ctx.res, 200, { product: productView(getProduct(p.id)!), quorumId, attachedIntents: attached });
  });

  route('PUT', '/api/merchant/products/:id', async (ctx) => {
    requireMerchant(ctx);
    const p = getProduct(ctx.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const b = await readJson<any>(ctx.req);
    const listPrice = b.listPrice !== undefined ? Number(b.listPrice) : p.list_price;
    const floorPrice = b.floorPrice !== undefined ? Number(b.floorPrice) : p.floor_price;
    validatePrices(listPrice, floorPrice);
    const openGroup = listQuorums('open').some((q) => q.product_id === p.id);
    if (openGroup && (b.tiers !== undefined || b.listPrice !== undefined)) {
      throw new HttpError(409, 'Price tiers are locked while a group is open; buyers committed to them');
    }
    const tiers = b.tiers !== undefined ? cleanTiers(b.tiers, listPrice, floorPrice) : tiersOf(p).map((t) => ({ ...t, price: Math.max(t.price, floorPrice) }));
    run(
      'UPDATE products SET list_price = ?, floor_price = ?, stock = ?, tiers_json = ?, active = ? WHERE id = ?',
      listPrice, floorPrice,
      b.stock !== undefined ? Math.max(0, Math.floor(Number(b.stock) || 0)) : p.stock,
      JSON.stringify(tiers),
      b.active !== undefined ? (b.active ? 1 : 0) : p.active,
      p.id,
    );
    sendJson(ctx.res, 200, { product: productView(getProduct(p.id)!) });
  });

  route('POST', '/api/merchant/products/:id/open-group', async (ctx) => {
    requireMerchant(ctx);
    const p = getProduct(ctx.params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    if (listQuorums('open').some((q) => q.product_id === p.id)) throw new HttpError(409, 'This product already has an open group');
    const b = await readJson<{ hours?: number }>(ctx.req);
    const q = createQuorum(p, Number(b.hours) > 0 ? Number(b.hours) : config.quorum.hours, 'Opened by the merchant');
    run('UPDATE quorums SET market_json = ? WHERE id = ?', JSON.stringify(await marketSearch(p.title, { limit: 5 })), q.id);
    const attached = attachWaitingIntents(q.id, p);
    sendJson(ctx.res, 200, { quorumId: q.id, attachedIntents: attached });
  });
}

async function cron(ctx: Ctx) {
  const secret = ctx.url.searchParams.get('secret') ?? ctx.req.headers.authorization?.replace(/^Bearer /, '');
  if (!config.demoAdmin && (!config.cronSecret || secret !== config.cronSecret)) throw new HttpError(403, 'Forbidden');
  const results = await settleDue();
  sendJson(ctx.res, 200, { settled: results });
}

function validatePrices(listPrice: number, floorPrice: number) {
  if (!(listPrice > 0) || !(floorPrice > 0)) throw new HttpError(400, 'List price and floor price must be positive');
  if (floorPrice > listPrice) throw new HttpError(400, 'Floor price cannot be above the list price');
}

/** Tiers from the console: never above list, never below the merchant floor. */
function cleanTiers(raw: unknown, listPrice: number, floorPrice: number): Tier[] {
  const arr = Array.isArray(raw) ? raw : [];
  const tiers = arr
    .map((t: any) => ({ min: Math.floor(Number(t.min)), price: Number(t.price) }))
    .filter((t) => t.min > 1 && t.price > 0)
    .map((t) => ({ min: Math.min(t.min, 500), price: Math.min(listPrice, Math.max(floorPrice, t.price)) }));
  if (!tiers.length) throw new HttpError(400, 'Add at least one volume tier (for example: 5 buyers at a lower price)');
  return normalizeTiers([{ min: 1, price: listPrice }, ...tiers], listPrice);
}

export function productView(p: Product) {
  const open = listQuorums('open').find((q) => q.product_id === p.id);
  return {
    id: p.id,
    merchantId: p.merchant_id,
    title: p.title,
    category: p.category,
    description: p.description,
    keywords: p.keywords,
    listPrice: p.list_price,
    floorPrice: p.floor_price,
    stock: p.stock,
    tiers: tiersOf(p),
    active: Boolean(p.active),
    openQuorumId: open?.id ?? null,
  };
}
