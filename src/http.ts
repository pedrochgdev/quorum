// Tiny HTTP toolkit on node:http: routing, JSON bodies, static files.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
};
export type Handler = (ctx: Ctx) => Promise<void> | void;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Route = { method: string; re: RegExp; keys: string[]; handler: Handler };
const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp(
    '^' + path.replace(/\/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), '/([^/]+)')) + '/?$',
  );
  routes.push({ method, re, keys, handler });
}

export function match(method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(html);
}

export function redirect(res: ServerResponse, to: string) {
  res.writeHead(303, { Location: to, ...SECURITY_HEADERS });
  res.end();
}

export async function readJson<T = any>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {} as T;
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text)) as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const PUBLIC_DIR = resolve(process.cwd(), 'public');

export function serveStatic(pathname: string, res: ServerResponse): boolean {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=300',
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(res);
  return true;
}

// Simple fixed-window rate limiter, per client IP and bucket.
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(req: IncomingMessage, bucket: string, max: number, windowMs = 60_000) {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++h.n > max) throw new HttpError(429, 'Too many requests, slow down a little');
}
