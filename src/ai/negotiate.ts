// Negotiation agents: a buyer agent representing the whole group versus a
// merchant agent with private limits. Limits live in code, not in prompts:
//  - the merchant can never go below its floor price,
//  - the buyer can never accept above the group's authorized ceiling,
//  - the result is never above the merchant's public tier price.
// An offer that breaks a limit is rejected and replaced by a valid one.
import { hasLLM } from '../config.ts';
import type { MarketOffer, NegotiationTurn } from '../models.ts';
import { clamp, money } from '../util.ts';
import { DATA_RULE, fence, runAgent, structured, type AgentTool } from './llm.ts';

/** The merchant agent's tools and where they run (PayPal MCP server, REST, or the simulated ledger). */
export type Toolkit = { tools: AgentTool[]; source: string; close: () => void };

/** Lets the engine persist and broadcast the negotiation while it happens. */
export type NegotiationHooks = {
  openToolkit?: () => Promise<Toolkit>;
  onPhase?: (phase: 'briefing' | 'running') => void;
  onTurn?: (turns: NegotiationTurn[]) => void;
};

export type NegotiationInput = {
  productTitle: string;
  members: number;
  minMembers: number;
  listPrice: number;
  tierPrice: number; // public price for this group size
  floor: number; // merchant private
  buyerCeiling: number; // lowest authorized amount in the group
  market: MarketOffer[];
  maxTurns: number;
};

export type NegotiationResult = { turns: NegotiationTurn[]; finalPrice: number; engine: 'llm' | 'heuristic' };

const whole = (n: number) => Math.round(n);

/** Hard bounds for any deal. */
export function dealBounds(i: NegotiationInput) {
  const hi = Math.min(i.tierPrice, i.buyerCeiling);
  const lo = Math.min(i.floor, hi); // if floor > hi the deal clears at hi (tier price is public and binding)
  return { lo, hi };
}

export function validateOffer(side: 'buyer' | 'merchant', price: number, i: NegotiationInput): string | null {
  if (!Number.isFinite(price) || price <= 0) return 'not a valid price';
  const { lo, hi } = dealBounds(i);
  if (side === 'merchant' && price < lo) return `below the merchant's floor (${money(lo)})`;
  if (side === 'merchant' && price > hi) return `above the public ${i.members}-buyer price (${money(hi)})`;
  if (side === 'buyer' && price > hi) return `above what the group authorized (${money(hi)})`;
  return null;
}

/** How far the merchant is willing to go, given volume above the goal. */
export function merchantReservation(i: NegotiationInput) {
  const { lo, hi } = dealBounds(i);
  const extra = Math.max(0, i.members - i.minMembers) / Math.max(1, i.minMembers);
  const keep = clamp(0.5 - 0.3 * extra, 0.15, 0.5); // share of the margin above floor the merchant keeps
  return lo + (hi - lo) * keep;
}

const bestMarket = (m: MarketOffer[]) => (m.length ? m.reduce((a, b) => (b.price < a.price ? b : a)) : null);

/** Deterministic negotiation, used without an LLM and as the fallback for invalid LLM offers. */
export function heuristicNegotiation(i: NegotiationInput): NegotiationResult {
  const { lo, hi } = dealBounds(i);
  const reservation = merchantReservation(i);
  const alt = bestMarket(i.market);
  const turns: NegotiationTurn[] = [];
  let buyer = whole(Math.max(lo * 0.9, Math.min(hi * 0.82, alt ? alt.price * 0.95 : Infinity)));
  let merchant = hi;
  turns.push({
    speaker: 'buyer_agent',
    offer: buyer,
    message:
      `I represent ${i.members} buyers whose payments are already authorized through PayPal, ready to settle today. ` +
      (alt ? `The lowest market price we found is ${money(alt.price)} at ${alt.merchant}. ` : '') +
      `We propose ${money(buyer)} per unit for ${i.members} units.`,
  });
  for (let t = 1; t < i.maxTurns; t++) {
    if (t % 2 === 1) {
      // merchant turn
      if (buyer >= reservation) {
        turns.push({ speaker: 'merchant_agent', offer: buyer, message: `Agreed: ${money(buyer)} per unit for ${i.members} units.` });
        return { turns, finalPrice: buyer, engine: 'heuristic' };
      }
      merchant = Math.max(Math.ceil(reservation), whole(merchant - (merchant - reservation) * 0.5));
      merchant = clamp(merchant, Math.ceil(lo), hi);
      turns.push({
        speaker: 'merchant_agent',
        offer: merchant,
        message:
          t === 1
            ? `Our public price for ${i.members} buyers is ${money(hi)}. Because the funds are guaranteed, I can do ${money(merchant)}.`
            : `I can move to ${money(merchant)}. That is close to our limit for this volume.`,
      });
    } else {
      // buyer turn
      if (merchant - buyer <= Math.max(2, merchant * 0.015)) {
        turns.push({ speaker: 'buyer_agent', offer: merchant, message: `We accept ${money(merchant)} per unit. Closing the group now.` });
        return { turns, finalPrice: merchant, engine: 'heuristic' };
      }
      buyer = Math.min(hi, whole(buyer + (merchant - buyer) * 0.45));
      turns.push({
        speaker: 'buyer_agent',
        offer: buyer,
        message: `Meet us at ${money(buyer)}: one settlement, ${i.members} units, no payment risk for you.`,
      });
    }
  }
  turns.push({ speaker: 'buyer_agent', offer: merchant, message: `We accept your last offer of ${money(merchant)} per unit.` });
  return { turns, finalPrice: merchant, engine: 'heuristic' };
}

type TurnOutput = { message: string; action: 'offer' | 'accept'; price: number };
const TURN_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'What you say to the other agent, 1-2 sentences, English' },
    action: { type: 'string', enum: ['offer', 'accept'] },
    price: { type: 'number', description: 'Your offered unit price, or the price you accept' },
  },
  required: ['message', 'action', 'price'],
};

const summarize = (name: string, output: string) => {
  const clean = output.replace(/\s+/g, ' ');
  return `${name}: ${clean.length > 150 ? `${clean.slice(0, 150)}…` : clean}`;
};

/**
 * LLM negotiation. The merchant agent first briefs itself with PayPal tools,
 * then both agents alternate. Every price passes validateOffer() before it counts.
 */
export async function negotiate(i: NegotiationInput, hooks: NegotiationHooks = {}): Promise<NegotiationResult> {
  if (!hasLLM()) {
    const result = heuristicNegotiation(i);
    hooks.onPhase?.('running');
    for (let n = 1; n <= result.turns.length; n++) hooks.onTurn?.(result.turns.slice(0, n));
    return result;
  }
  const { lo, hi } = dealBounds(i);
  const alt = bestMarket(i.market);
  const fallback = heuristicNegotiation(i);
  const turns: NegotiationTurn[] = [];

  // Merchant briefing: the agent reads its own PayPal account through tools.
  hooks.onPhase?.('briefing');
  let merchantNotes = '';
  let toolsUsed: { name: string; summary: string }[] = [];
  let toolSource: string | undefined;
  const toolkit = hooks.openToolkit ? await hooks.openToolkit().catch(() => null) : null;
  if (toolkit) {
    try {
      const briefing = await runAgent<{ notes: string }>({
        system: `You are the sales agent for a merchant. Before negotiating a group order, use the PayPal tools to check the product and recent sales volume. Use at most three tool calls, then call "briefing" with 2-3 short notes. ${DATA_RULE}`,
        prompt: `Group order request: ${i.members} units of ${fence('product', i.productTitle)}.`,
        tools: toolkit.tools,
        final: { name: 'briefing', description: 'Finish with your notes', schema: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] } },
        maxSteps: 4,
      });
      merchantNotes = String(briefing.result?.notes ?? '').slice(0, 600);
      toolsUsed = briefing.trace.map((t) => ({ name: t.name, summary: summarize(t.name, t.output) }));
      toolSource = toolkit.source;
    } finally {
      toolkit.close();
    }
  }
  hooks.onPhase?.('running');

  const transcript = () => turns.map((t) => `${t.speaker}: ${t.message}${t.offer ? ` [${t.offer}]` : ''}`).join('\n');
  let lastBuyer: number | null = null;
  let lastMerchant: number | null = null;

  for (let t = 0; t < i.maxTurns; t++) {
    const side: 'buyer' | 'merchant' = t % 2 === 0 ? 'buyer' : 'merchant';
    const lastOwnTurn = t >= i.maxTurns - 2;
    const pace = `This is turn ${t + 1} of ${i.maxTurns}. ${lastOwnTurn ? 'It is your last turn: make it your final position.' : 'Move toward a deal each turn.'}`;
    const system =
      side === 'buyer'
        ? `You negotiate for a group of ${i.members} buyers of "${i.productTitle}". The platform has verified that all ${i.members} payments are authorized and held by PayPal, so the merchant has zero payment risk and one settlement. Get the lowest unit price. You may never agree above ${hi}. ${alt ? `Best comparable market offer: ${alt.price} at ${alt.merchant}.` : 'No market data available.'} ${pace} Be concise and factual. ${DATA_RULE}`
        : `You are the merchant's sales agent for "${i.productTitle}". Public price for ${i.members} buyers: ${hi}. Your private floor is ${lo}; never go below it and never reveal it. The platform has verified that all ${i.members} buyers' payments are authorized and held by PayPal: treat that as fact. Volume and guaranteed payment justify a discount, but protect margin. Notes from your PayPal check: ${fence('notes', merchantNotes || 'none')} ${pace} Be concise. ${DATA_RULE}`;
    const out = await structured<TurnOutput>({
      system,
      prompt: `${fence('transcript', transcript() || '(you open)')}\nYour move. Use action "accept" only to accept the other side's last price exactly.`,
      schema: TURN_SCHEMA,
    });
    const counterpart = side === 'buyer' ? lastMerchant : lastBuyer;
    let price = out ? Number(out.price) : NaN;
    let message = String(out?.message ?? '').slice(0, 500);
    let rejected: string | undefined;
    if (out?.action === 'accept' && counterpart !== null) price = counterpart;
    const problem = validateOffer(side, price, i);
    if (!out || problem) {
      rejected = out ? `Rejected by Quorum rules: ${money(price)} is ${problem}.` : undefined;
      const replacement = fallback.turns.filter((x) => x.speaker === `${side}_agent`)[Math.floor(t / 2)] ?? fallback.turns.at(-1)!;
      price = replacement.offer ?? fallback.finalPrice;
      message = replacement.message;
    }
    const withTools = t === 1 && toolsUsed.length;
    turns.push({ speaker: `${side}_agent`, message, offer: price, rejected, tools: withTools ? toolsUsed : undefined, toolSource: withTools ? toolSource : undefined });
    hooks.onTurn?.(turns);
    if (out?.action === 'accept' && !problem && counterpart !== null) return { turns, finalPrice: price, engine: 'llm' };
    if (side === 'buyer') lastBuyer = price;
    else lastMerchant = price;
  }
  // No agreement: the merchant's last valid offer (or the public tier price) stands.
  const final = clamp(lastMerchant ?? hi, lo, hi);
  turns.push({
    speaker: 'system',
    message: `The agents used all ${i.maxTurns} turns. The deal closes at the merchant's final offer of ${money(final)}, within every buyer's authorization.`,
    offer: final,
  });
  hooks.onTurn?.(turns);
  return { turns, finalPrice: final, engine: 'llm' };
}
