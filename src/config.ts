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
// Tests must never pick up real keys: `node --test` sets NODE_TEST_CONTEXT, and the
// end-to-end scripts start the server with QUORUM_ENV_FILE=none.
const envFile = process.env.QUORUM_ENV_FILE ?? '.env';
if (envFile !== 'none' && !process.env.NODE_TEST_CONTEXT) loadDotEnv(resolve(process.cwd(), envFile));

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
    // The merchant agent reads PayPal through PayPal's own remote MCP server. "off" uses the REST API directly.
    mcp: env('PAYPAL_MCP', 'on').toLowerCase() !== 'off',
    // Send each order to the merchant's own PayPal account (purchase_units[].payee). Off by default:
    // capturing for another account needs that account's permission, so verify it on your sandbox first.
    payeeRouting: bool('PAYPAL_PAYEE_ROUTING', false),
  },

  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    fastModel: env('ANTHROPIC_FAST_MODEL', 'claude-haiku-5-5'),
  },

  openai: {
    apiKey: env('OPENAI_API_KEY') || env('GPT_API_KEY'),
    model: env('OPENAI_MODEL', 'gpt-6-luna'),
    fastModel: env('OPENAI_FAST_MODEL', env('OPENAI_MODEL', 'gpt-6-luna')),
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
    // After a group closes, late buyers can still join at the final price for this long.
    // If they push the group into a cheaper tier, everyone already charged gets the difference refunded.
    lateJoinHours: num('LATE_JOIN_HOURS', 24),
  },

  notify: {
    resendApiKey: env('RESEND_API_KEY'),
    from: env('NOTIFY_FROM', 'Quorum <onboarding@resend.dev>'),
  },

  demoAdmin: bool('DEMO_ADMIN', false),
  // Hosted demos: seed an empty database at start, and put the demo back when it is used up and idle.
  demoAutoReset: bool('DEMO_AUTO_RESET', false),
  cronSecret: env('CRON_SECRET'),
};

export const isMockPayPal = () => config.paypal.mode === 'mock';
export function llmProvider(): 'anthropic' | 'openai' | null {
  if (config.anthropic.apiKey) return 'anthropic';
  if (config.openai.apiKey) return 'openai';
  return null;
}

export const hasLLM = () => Boolean(llmProvider());
export function llmModel(fast = false): string {
  const settings = config[llmProvider() ?? 'anthropic'];
  return fast ? settings.fastModel : settings.model;
}
export const hasChannel3 = () => Boolean(config.channel3.apiKey);

export function describeModes() {
  const provider = llmProvider();
  return {
    paypal: config.paypal.mode,
    ai: provider ? provider + ':' + llmModel() : 'heuristic (no LLM API key)',
    embeddings: config.openaiEmbeddings.apiKey ? `openai:${config.openaiEmbeddings.model}` : 'local hashed n-grams',
    channel3: hasChannel3() ? 'live' : 'off (no CHANNEL3_API_KEY)',
    merchantTools: config.paypal.mode === 'mock' ? 'simulated ledger' : config.paypal.mcp ? 'PayPal MCP server' : 'PayPal REST API',
    email: config.notify.resendApiKey ? 'resend' : 'outbox only (no RESEND_API_KEY)',
  };
}
