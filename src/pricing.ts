// Price tiers: the merchant's public volume schedule.
// tiers = [{ min: 1, price: 199 }, { min: 5, price: 179 }, { min: 8, price: 169 }]
import { round2 } from './util.ts';

export type Tier = { min: number; price: number };

export function normalizeTiers(tiers: Tier[], listPrice: number): Tier[] {
  const clean = tiers
    .filter((t) => Number.isFinite(t.min) && Number.isFinite(t.price) && t.min >= 1 && t.price > 0)
    .map((t) => ({ min: Math.floor(t.min), price: round2(t.price) }));
  if (!clean.some((t) => t.min === 1)) clean.push({ min: 1, price: round2(listPrice) });
  clean.sort((a, b) => a.min - b.min);
  // Prices must not rise with volume: keep each tier at most the previous one.
  const out: Tier[] = [];
  for (const t of clean) {
    if (out.length && out[out.length - 1].min === t.min) continue;
    const prev = out[out.length - 1];
    out.push({ min: t.min, price: prev ? Math.min(prev.price, t.price) : t.price });
  }
  return out;
}

/** The group's goal: the first tier that gives a discount. */
export function minMembers(tiers: Tier[]): number {
  const discount = tiers.find((t) => t.min > 1);
  return discount ? discount.min : 2;
}

export function priceFor(tiers: Tier[], members: number): number {
  let price = tiers[0].price;
  for (const t of tiers) if (members >= t.min) price = t.price;
  return price;
}

export function nextTier(tiers: Tier[], members: number): Tier | null {
  return tiers.find((t) => t.min > members) ?? null;
}

/** What one more member is worth to everyone already in the group. */
export function growthMath(tiers: Tier[], members: number) {
  const current = priceFor(tiers, members);
  const next = nextTier(tiers, members);
  if (!next) return { current, next: null, needed: 0, savingPerPerson: 0, unlockPrice: current };
  const needed = next.min - members;
  return {
    current,
    next,
    needed,
    unlockPrice: next.price,
    savingPerPerson: round2(current - next.price),
  };
}

/**
 * Price-drop rule for a closed group that keeps growing. The agents agreed on
 * a price while a given public tier applied. When late buyers reach a cheaper
 * tier, the price falls by the same amount the public price fell, and never
 * below the merchant's floor.
 */
export function droppedPrice(negotiated: number, tierAtDeal: number, tierNow: number, floor: number): number {
  const drop = Math.max(0, tierAtDeal - tierNow);
  return round2(Math.max(floor, negotiated - drop));
}

/**
 * The amount we ask PayPal to authorize. It is the list price, capped by the
 * buyer's own maximum, but never below what the goal tier requires.
 */
export function authorizationAmount(tiers: Tier[], buyerMax: number | null | undefined): number | null {
  const list = tiers[0].price;
  const goalPrice = priceFor(tiers, minMembers(tiers));
  if (buyerMax === null || buyerMax === undefined || !Number.isFinite(buyerMax)) return list;
  if (buyerMax < goalPrice) return null; // can't cover even the group price
  return round2(Math.min(list, buyerMax));
}
