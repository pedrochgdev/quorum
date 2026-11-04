// Market data from Channel3 (POST /v1/search, x-api-key header).
// Used to show buyers the market price and to arm the buyer agent with
// real alternatives. Without a key, Quorum shows no market data: it never
// invents prices.
import { config, hasChannel3 } from '../config.ts';
import type { MarketOffer } from '../models.ts';

const cache = new Map<string, { at: number; offers: MarketOffer[] }>();
const TTL = 60 * 60 * 1000;

function parsePrice(p: any): number | null {
  if (p === null || p === undefined) return null;
  if (typeof p === 'number') return p;
  if (typeof p === 'string') return Number(p.replace(/[^0-9.]/g, '')) || null;
  if (typeof p === 'object') return parsePrice(p.amount ?? p.price ?? p.value ?? p.current);
  return null;
}

/** Defensive mapping: the product object carries offers with price and merchant. */
export function mapChannel3Products(json: any): MarketOffer[] {
  const products: any[] = json?.products ?? json?.results ?? (Array.isArray(json) ? json : []);
  const out: MarketOffer[] = [];
  for (const p of products) {
    const offers: any[] = Array.isArray(p.offers) ? p.offers : [];
    const best = offers
      .map((o) => ({ o, price: parsePrice(o.price) }))
      .filter((x) => x.price !== null)
      .sort((a, b) => a.price! - b.price!)[0];
    const price = best?.price ?? parsePrice(p.price);
    if (!price || !p.title) continue;
    const image = p.image_url ?? p.images?.[0]?.url ?? p.images?.[0] ?? undefined;
    out.push({
      title: String(p.title).slice(0, 140),
      price,
      merchant: String(best?.o?.domain ?? best?.o?.merchant ?? p.domain ?? p.brand_name ?? p.brands?.[0]?.name ?? 'retailer'),
      url: best?.o?.url ?? p.url,
      image: typeof image === 'string' ? image : undefined,
    });
  }
  return out;
}

export async function marketSearch(query: string, opts: { maxPrice?: number | null; limit?: number } = {}): Promise<MarketOffer[]> {
  if (!hasChannel3()) return [];
  const key = `${query}|${opts.maxPrice ?? ''}|${opts.limit ?? 5}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.offers;
  try {
    const body: Record<string, unknown> = { query, limit: opts.limit ?? 5 };
    if (opts.maxPrice) body.filters = { price: { max_price: opts.maxPrice } };
    const res = await fetch(`${config.channel3.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { 'x-api-key': config.channel3.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Channel3 ${res.status}`);
    const offers = mapChannel3Products(await res.json()).sort((a, b) => a.price - b.price);
    cache.set(key, { at: Date.now(), offers });
    return offers;
  } catch (err) {
    console.warn('[channel3] search failed:', (err as Error).message);
    return [];
  }
}
