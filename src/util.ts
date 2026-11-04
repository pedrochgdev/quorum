import { randomBytes } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('base64url')}`;

export const nowIso = () => new Date().toISOString();

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const money = (n: number | null | undefined, currency = 'USD') =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

export const amountString = (n: number) => round2(n).toFixed(2);

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 254;
}
