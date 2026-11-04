// Typed data access and the "view" objects the API and pages render.
import { all, get, run } from './db.ts';
import { growthMath, minMembers, normalizeTiers, priceFor, type Tier } from './pricing.ts';
import { newId, nowIso, safeJson } from './util.ts';

export type Merchant = { id: string; name: string; paypal_email: string | null; created_at: string };

export type Product = {
  id: string;
  merchant_id: string;
  title: string;
  category: string;
  description: string;
  keywords: string;
  image_url: string | null;
  list_price: number;
  floor_price: number;
  stock: number;
  tiers_json: string;
  embedding_json: string | null;
  paypal_catalog_id: string | null;
  active: number;
  created_at: string;
};

export type QuorumStatus = 'open' | 'negotiating' | 'settling' | 'closed' | 'failed';
export type Quorum = {
  id: string;
  product_id: string;
  merchant_id: string;
  title: string;
  status: QuorumStatus;
  min_members: number;
  closes_at: string;
  final_price: number | null;
  market_json: string | null;
  summary: string | null;
  created_at: string;
  closed_at: string | null;
};

export type Intent = {
  id: string;
  email: string | null;
  text: string;
  parsed_json: string;
  category: string;
  max_price: number | null;
  deadline: string | null;
  embedding_json: string;
  quorum_id: string | null;
  status: 'grouped' | 'waiting' | 'committed';
  reason: string | null;
  created_at: string;
};

export type CommitmentStatus = 'created' | 'authorized' | 'captured' | 'voided' | 'failed';
export type Commitment = {
  id: string;
  quorum_id: string;
  intent_id: string | null;
  email: string;
  display_name: string;
  provider: 'paypal' | 'mock';
  paypal_order_id: string | null;
  authorization_id: string | null;
  authorized_amount: number;
  captured_amount: number | null;
  capture_id: string | null;
  status: CommitmentStatus;
  failure_reason: string | null;
  referrer_id: string | null;
  authorized_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MarketOffer = { title: string; price: number; merchant: string; url?: string; image?: string };

export type NegotiationTurn = {
  speaker: 'buyer_agent' | 'merchant_agent' | 'system';
  message: string;
  offer?: number;
  rejected?: string;
  tools?: { name: string; summary: string }[];
};

export const tiersOf = (p: Product): Tier[] => normalizeTiers(safeJson<Tier[]>(p.tiers_json, []), p.list_price);

export const getMerchant = (id: string) => get<Merchant>('SELECT * FROM merchants WHERE id = ?', id);
export const listMerchants = () => all<Merchant>('SELECT * FROM merchants ORDER BY created_at');
export const getProduct = (id: string) => get<Product>('SELECT * FROM products WHERE id = ?', id);
export const listProducts = (onlyActive = true) =>
  all<Product>(`SELECT * FROM products ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY created_at`);
export const getQuorum = (id: string) => get<Quorum>('SELECT * FROM quorums WHERE id = ?', id);
export const listQuorums = (status?: QuorumStatus) =>
  status
    ? all<Quorum>('SELECT * FROM quorums WHERE status = ? ORDER BY created_at DESC', status)
    : all<Quorum>('SELECT * FROM quorums ORDER BY created_at DESC');
export const getIntent = (id: string) => get<Intent>('SELECT * FROM intents WHERE id = ?', id);
export const getCommitment = (id: string) => get<Commitment>('SELECT * FROM commitments WHERE id = ?', id);
export const commitmentsFor = (quorumId: string) =>
  all<Commitment>('SELECT * FROM commitments WHERE quorum_id = ? ORDER BY created_at', quorumId);

export const authorizedCount = (quorumId: string) =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM commitments WHERE quorum_id = ? AND status IN ('authorized','captured')", quorumId)!.n;

export function createMerchant(name: string, paypalEmail: string | null = null): Merchant {
  const m = { id: newId('mer'), name, paypal_email: paypalEmail, created_at: nowIso() };
  run('INSERT INTO merchants (id, name, paypal_email, created_at) VALUES (?,?,?,?)', m.id, m.name, m.paypal_email, m.created_at);
  return m;
}

export function createProduct(p: {
  merchantId: string;
  title: string;
  category: string;
  description?: string;
  keywords?: string;
  imageUrl?: string | null;
  listPrice: number;
  floorPrice: number;
  stock?: number;
  tiers: Tier[];
  embedding?: number[];
}): Product {
  const id = newId('prd');
  const tiers = normalizeTiers(p.tiers, p.listPrice);
  run(
    `INSERT INTO products (id, merchant_id, title, category, description, keywords, image_url, list_price, floor_price, stock, tiers_json, embedding_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, p.merchantId, p.title, p.category, p.description ?? '', p.keywords ?? '', p.imageUrl ?? null,
    p.listPrice, p.floorPrice, p.stock ?? 0, JSON.stringify(tiers), p.embedding ? JSON.stringify(p.embedding) : null, nowIso(),
  );
  return getProduct(id)!;
}

export function createQuorum(product: Product, hoursOpen: number, summary: string): Quorum {
  const id = newId('q');
  const tiers = tiersOf(product);
  const closes = new Date(Date.now() + hoursOpen * 3600_000).toISOString();
  run(
    `INSERT INTO quorums (id, product_id, merchant_id, title, status, min_members, closes_at, summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, product.id, product.merchant_id, product.title, 'open', minMembers(tiers), closes, summary, nowIso(),
  );
  return getQuorum(id)!;
}

/** Everything a page or API client needs to show one group. */
export function quorumView(q: Quorum) {
  const product = getProduct(q.product_id)!;
  const merchant = getMerchant(q.merchant_id)!;
  const tiers = tiersOf(product);
  const commitments = commitmentsFor(q.id);
  const members = commitments.filter((c) => c.status === 'authorized' || c.status === 'captured');
  const count = members.length;
  const negotiation = get<{ turns_json: string; final_price: number | null; status: string; engine: string }>(
    'SELECT turns_json, final_price, status, engine FROM negotiations WHERE quorum_id = ? ORDER BY created_at DESC LIMIT 1', q.id,
  );
  return {
    id: q.id,
    title: q.title,
    status: q.status,
    summary: q.summary,
    closesAt: q.closes_at,
    closedAt: q.closed_at,
    minMembers: q.min_members,
    members: count,
    goalReached: count >= q.min_members,
    currentPrice: priceFor(tiers, count),
    finalPrice: q.final_price,
    growth: growthMath(tiers, count),
    tiers,
    product: {
      id: product.id,
      title: product.title,
      category: product.category,
      description: product.description,
      imageUrl: product.image_url,
      listPrice: product.list_price,
      stock: product.stock,
    },
    merchant: { id: merchant.id, name: merchant.name },
    market: safeJson<MarketOffer[]>(q.market_json, []),
    commitments: commitments.map((c) => ({
      id: c.id,
      name: c.display_name,
      status: c.status,
      provider: c.provider,
      authorized: c.authorized_amount,
      captured: c.captured_amount,
      referrer: c.referrer_id,
      at: c.authorized_at ?? c.created_at,
    })),
    payouts: all<{ commitment_id: string; amount: number; status: string }>(
      'SELECT commitment_id, amount, status FROM payouts WHERE quorum_id = ? ORDER BY created_at', q.id,
    ).map((p) => ({
      commitmentId: p.commitment_id,
      name: commitments.find((c) => c.id === p.commitment_id)?.display_name ?? 'member',
      amount: p.amount,
      status: p.status,
    })),
    negotiation: negotiation
      ? {
          status: negotiation.status,
          engine: negotiation.engine,
          finalPrice: negotiation.final_price,
          turns: safeJson<NegotiationTurn[]>(negotiation.turns_json, []),
        }
      : null,
  };
}
export type QuorumView = ReturnType<typeof quorumView>;
