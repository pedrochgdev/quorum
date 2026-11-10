// Growth agent: turns each member into a recruiter by showing exactly what one
// more person is worth, and drafting the invite for them.
import { config } from '../config.ts';
import type { QuorumView } from '../models.ts';
import { money } from '../util.ts';
import { DATA_RULE, fence, structured } from './llm.ts';

export type Invite = {
  headline: string;
  message: string;
  link: string;
  whatsapp: string;
  email: string;
  tip: string;
  engine: 'llm' | 'heuristic';
};

const hoursLeft = (closesAt: string) => Math.max(0, (Date.parse(closesAt) - Date.now()) / 3600_000);

/** When to push: the first third of the goal and the last hours matter most. */
export function momentumTip(v: QuorumView): string {
  const progress = v.members / Math.max(1, v.minMembers);
  const h = hoursLeft(v.closesAt);
  if (!v.goalReached && progress < 0.34) return 'Reaching a third of the goal is the hardest step. Invite the people most likely to say yes first.';
  if (!v.goalReached && h < 12) return `Only ${Math.ceil(h)} hours left and ${v.minMembers - v.members} more needed. A direct message works better than a post now.`;
  if (!v.goalReached) return `${v.minMembers - v.members} more and the group forms. Everyone already in can invite one person.`;
  if (v.growth.next) return `The group is formed. ${v.growth.needed} more unlocks ${money(v.growth.unlockPrice)} for everyone.`;
  return 'The group is at the best price tier. Share it anyway: the merchant may beat the tier when it negotiates.';
}

export function headlineFor(v: QuorumView): string {
  const g = v.growth;
  const goalPrice = v.tiers.find((t) => t.min === v.minMembers)?.price ?? v.currentPrice;
  const missing = v.minMembers - v.members;
  if (!v.goalReached) return `${missing} more ${missing === 1 ? 'person' : 'people'} and everyone pays ${money(goalPrice)}`;
  if (g.next) return `Each new member saves everyone ${money(g.savingPerPerson)} once ${g.needed} more join`;
  return `Best tier reached: ${money(v.currentPrice)} each`;
}

const esTip = (v: QuorumView): string => {
  const progress = v.members / Math.max(1, v.minMembers);
  const h = hoursLeft(v.closesAt);
  if (!v.goalReached && progress < 0.34) return 'Llegar a un tercio de la meta es el paso más difícil. Invita primero a quienes más probablemente digan que sí.';
  if (!v.goalReached && h < 12) return `Quedan ${Math.ceil(h)} horas y faltan ${v.minMembers - v.members}. Ahora funciona mejor un mensaje directo que una publicación.`;
  if (!v.goalReached) return `Faltan ${v.minMembers - v.members} y el grupo se forma. Cada persona que ya está dentro puede invitar a una más.`;
  if (v.growth.next) return `El grupo ya se formó. Con ${v.growth.needed} más, todos pagan ${money(v.growth.unlockPrice)}.`;
  return 'El grupo ya está en el mejor precio público. Compártelo igual: el comercio puede mejorar el precio al negociar.';
};

const esHeadline = (v: QuorumView): string => {
  const goalPrice = v.tiers.find((t) => t.min === v.minMembers)?.price ?? v.currentPrice;
  const missing = v.minMembers - v.members;
  if (!v.goalReached) return `${missing} ${missing === 1 ? 'persona más' : 'personas más'} y todos pagan ${money(goalPrice)}`;
  if (v.growth.next) return `Con ${v.growth.needed} más, cada uno ahorra ${money(v.growth.savingPerPerson)} adicionales`;
  return `Mejor precio alcanzado: ${money(v.currentPrice)} cada uno`;
};

export async function inviteFor(v: QuorumView, commitmentId: string | null, lang = 'en'): Promise<Invite> {
  const es = lang === 'es';
  const link = `${config.baseUrl}/q/${v.id}${commitmentId ? `?ref=${encodeURIComponent(commitmentId)}` : ''}`;
  const goalPrice = v.tiers.find((t) => t.min === v.minMembers)?.price ?? v.currentPrice;
  const template = es
    ? `Estoy comprando ${v.product.title} en grupo con Quorum. ` +
      (v.goalReached
        ? `Ya somos ${v.members}, así que sale a ${money(v.currentPrice)} en vez de ${money(v.product.listPrice)}` +
          (v.growth.next ? `, y con ${v.growth.needed} más baja a ${money(v.growth.unlockPrice)}.` : '.')
        : `Si se suman ${v.minMembers - v.members} más, todos pagamos ${money(goalPrice)} en vez de ${money(v.product.listPrice)}.`) +
      ` No se cobra a nadie si el grupo no se forma. Únete: ${link}`
    :
    `I'm buying ${v.product.title} with a group on Quorum. ` +
    (v.goalReached
      ? `We're already ${v.members}, so it's ${money(v.currentPrice)} instead of ${money(v.product.listPrice)}` +
        (v.growth.next ? `, and ${v.growth.needed} more drops it to ${money(v.growth.unlockPrice)}.` : '.')
      : `If ${v.minMembers - v.members} more join, we all pay ${money(goalPrice)} instead of ${money(v.product.listPrice)}.`) +
    ` Nobody is charged unless the group forms. Join: ${link}`;

  let message = template;
  let engine: Invite['engine'] = 'heuristic';
  const drafted = await structured<{ message: string }>({
    system: `You write short, friendly invite messages a person sends to friends to join a group purchase. Plain words, no hype, no emoji, under 300 characters before the link. Must state: the product, the price with the group vs alone, that nobody is charged unless the group forms. ${es ? 'Write the message in Spanish. ' : ''}End with the link exactly as given. ${DATA_RULE}`,
    prompt: [
      fence('product', v.product.title),
      `Members: ${v.members}. Goal: ${v.minMembers}. List price: ${v.product.listPrice}. Current group price: ${v.currentPrice}. Goal price: ${goalPrice}.`,
      v.growth.next ? `Next tier: ${v.growth.next.min} members at ${v.growth.unlockPrice}.` : 'Best tier already reached.',
      `Hours left: ${Math.ceil(hoursLeft(v.closesAt))}. Link: ${link}`,
    ].join('\n'),
    schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    fast: true,
  });
  if (drafted?.message && drafted.message.includes(link) && drafted.message.length < 600) {
    message = drafted.message;
    engine = 'llm';
  }
  return {
    headline: es ? esHeadline(v) : headlineFor(v),
    message,
    link,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
    email: `mailto:?subject=${encodeURIComponent(es ? `Únete a mi grupo: ${v.product.title}` : `Join my group for ${v.product.title}`)}&body=${encodeURIComponent(message)}`,
    tip: es ? esTip(v) : momentumTip(v),
    engine,
  };
}
