// Embeddings for grouping similar purchase intents.
// Default: a local hashed n-gram embedding (no network, deterministic) with a
// small English/Spanish synonym map. Optional: OpenAI embeddings.
import { config } from '../config.ts';

const DIM = 512;

// Spanish (and a few English variants) mapped to a shared English vocabulary,
// so "cafetera espresso" and "espresso machine" land close together.
const SYNONYMS: Record<string, string> = {
  cafetera: 'coffee machine',
  cafe: 'coffee',
  molinillo: 'grinder',
  molino: 'grinder',
  hervidor: 'kettle',
  tetera: 'kettle',
  pava: 'kettle',
  carpa: 'tent',
  tienda: 'tent',
  botella: 'bottle',
  termo: 'insulated bottle',
  audifonos: 'headphones',
  auriculares: 'headphones',
  cascos: 'headphones',
  parlante: 'speaker',
  altavoz: 'speaker',
  bocina: 'speaker',
  mochila: 'backpack',
  zapatillas: 'shoes',
  bicicleta: 'bike',
  silla: 'chair',
  escritorio: 'desk',
  lampara: 'lamp',
  licuadora: 'blender',
  freidora: 'air fryer',
  barata: 'cheap',
  barato: 'cheap',
  compacta: 'compact',
  compacto: 'compact',
  personas: 'person',
  ultraligera: 'ultralight',
  ligera: 'light',
  inalambricos: 'wireless',
  inalambrico: 'wireless',
  earbuds: 'headphones',
  headset: 'headphones',
  espresso: 'espresso',
  expreso: 'espresso',
  cisne: 'gooseneck',
  electrico: 'electric',
  electrica: 'electric',
  elevable: 'standing adjustable',
  ajustable: 'adjustable',
  ruido: 'noise',
  cancelacion: 'cancelling',
  agua: 'water',
  acero: 'steel',
  leche: 'milk',
  espumador: 'frother',
  ligero: 'light',
  dos: 'two',
};

const STOP = new Set(
  'a an the for to of and or with in on at by from is are be i me my we our you it this that want need looking buy some any under below less than more max maximum about around before after el la los las un una unos unas de del para por con sin que quiero necesito busco comprar menos mas máximo maximo hasta antes despues y o en mi mis es son algo usd dollar dollars dolar dolares bucks cuello'.split(' '),
);

export function normalizeText(s: string): string[] {
  const base = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ');
  const out: string[] = [];
  for (const tok of base.split(/[\s-]+/)) {
    if (!tok || STOP.has(tok) || /^\d+$/.test(tok)) continue;
    const singular = tok.endsWith('s') ? tok.slice(0, -1) : tok;
    const mapped = SYNONYMS[tok] ?? SYNONYMS[singular] ?? tok;
    for (const m of mapped.split(' ')) {
      const t = m.length > 4 && m.endsWith('s') && !m.endsWith('ss') ? m.slice(0, -1) : m;
      out.push(t);
    }
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function localEmbed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const toks = normalizeText(text);
  const add = (feature: string, w: number) => {
    const h = fnv1a(feature);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  toks.forEach((t, i) => {
    add(`w:${t}`, 1.0);
    if (i > 0) add(`b:${toks[i - 1]}_${t}`, 0.6);
    const padded = `^${t}$`;
    for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, 0.25);
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export type Embedding = { model: string; v: number[] };

export async function embed(text: string): Promise<Embedding> {
  if (config.openaiEmbeddings.apiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.openaiEmbeddings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.openaiEmbeddings.model, input: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      if (res.ok && json.data?.[0]) return { model: config.openaiEmbeddings.model, v: json.data[0].embedding };
    } catch (err) {
      console.warn('[embed] OpenAI failed, using local embedding:', (err as Error).message);
    }
  }
  return { model: 'local', v: localEmbed(text) };
}

/** Similarity that degrades gracefully when two vectors come from different models. */
export function similarity(aText: string, a: Embedding | null, bText: string, b: Embedding | null): number {
  if (a && b && a.model === b.model) return cosine(a.v, b.v);
  return cosine(localEmbed(aText), localEmbed(bText));
}
