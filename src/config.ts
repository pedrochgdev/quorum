// Central configuration, read once from the environment.
// Every external service is optional: without credentials Quorum runs in a
// clearly labelled simulation mode so the full cycle can be demoed locally.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependencies). Real env vars win over the file.
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(resolve(process.cwd(), '.env'));

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d;
};
const bool = (k: string, d = false) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const paypalClientId = env('PAYPAL_CLIENT_ID');
const paypalSecret = env('PAYPAL_CLIENT_SECRET');
const requestedMode = env('PAYPAL_MODE').toLowerCase();

export const config = {
  port: num('PORT', 3000),
  baseUrl: env('BASE_URL', `http://localhost:${num('PORT', 3000)}`),
  dataDir: env('DATA_DIR', resolve(process.cwd(), 'data')),
  dbFile: env('DB_FILE', ''),

  paypal: {
    // "sandbox" | "live" | "mock". Defaults to mock when credentials are missing.
    mode: (requestedMode || (paypalClientId && paypalSecret ? 'sandbox' : 'mock')) as 'sandbox' | 'live' | 'mock',
    clientId: paypalClientId,
    clientSecret: paypalSecret,
    webhookId: env('PAYPAL_WEBHOOK_ID'),
    currency: env('CURRENCY', 'USD'),
  },

  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    fastModel: env('ANTHROPIC_FAST_MODEL', 'claude-haiku-5-5'),
  },

  openaiEmbeddings: {
    apiKey: env('OPENAI_API_KEY'),
    model: env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },

  channel3: {
    apiKey: env('CHANNEL3_API_KEY'),
    baseUrl: env('CHANNEL3_BASE_URL', 'https://api.trychannel3.com'),
  },

  quorum: {
    // How long a new group stays open. PayPal guarantees authorized funds for
    // 3 days (honor period), so the default stays at 72 hours.
    hours: num('QUORUM_HOURS', 72),
    settleIntervalSeconds: num('SETTLE_INTERVAL_SECONDS', 30),
    maxNegotiationTurns: num('MAX_NEGOTIATION_TURNS', 6),
    referralReward: num('REFERRAL_REWARD', 0),
  },

  demoAdmin: bool('DEMO_ADMIN', false),
  cronSecret: env('CRON_SECRET'),
};

export const isMockPayPal = () => config.paypal.mode === 'mock';
export const hasLLM = () => Boolean(config.anthropic.apiKey);
export const hasChannel3 = () => Boolean(config.channel3.apiKey);

export function describeModes() {
  return {
    paypal: config.paypal.mode,
    ai: hasLLM() ? `anthropic:${config.anthropic.model}` : 'heuristic (no ANTHROPIC_API_KEY)',
    embeddings: config.openaiEmbeddings.apiKey ? `openai:${config.openaiEmbeddings.model}` : 'local hashed n-grams',
    channel3: hasChannel3() ? 'live' : 'off (no CHANNEL3_API_KEY)',
  };
}
