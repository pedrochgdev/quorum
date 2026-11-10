import { createServer } from 'node:http';
import { config, describeModes } from './config.ts';
import { get, openDb } from './db.ts';
import { HttpError, match, route, sendHtml, sendJson, serveStatic, type Ctx } from './http.ts';
import { registerApi } from './api.ts';
import { registerMcp } from './mcp.ts';
import { CheckoutError, settleDue } from './engine.ts';
import { PayPalError } from './paypal/index.ts';
import { homePage, merchantPage, mockCheckoutPage, notFoundPage, quorumPage } from './web/pages.ts';

openDb();
registerApi();
registerMcp();

route('GET', '/', ({ res }) => sendHtml(res, 200, homePage()));
route('GET', '/q/:id', ({ res, params }) => sendHtml(res, 200, quorumPage(params.id)));
route('GET', '/merchant', ({ res }) => sendHtml(res, 200, merchantPage()));
route('GET', '/mock-paypal/checkout', ({ res, url }) => {
  const order = url.searchParams.get('order') ?? '';
  const row = get<{ amount: number }>("SELECT amount FROM mock_paypal WHERE id = ? AND kind = 'order'", order);
  const owner = get<{ quorum_id: string }>('SELECT quorum_id FROM commitments WHERE paypal_order_id = ?', order);
  sendHtml(res, row ? 200 : 404, mockCheckoutPage(order, row?.amount ?? null, owner?.quorum_id ?? null));
});

function errorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError || err instanceof CheckoutError) return { status: err.status, message: err.message };
  if (err instanceof PayPalError) {
    console.error('[paypal]', err.message, JSON.stringify(err.details));
    return { status: 502, message: `PayPal error: ${err.issue ?? err.message}` };
  }
  console.error(err);
  return { status: 500, message: 'Something went wrong' };
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  try {
    const m = match(method, url.pathname);
    if (m) {
      const ctx: Ctx = { req, res, url, params: m.params };
      await m.handler(ctx);
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && serveStatic(url.pathname, res)) return;
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    sendHtml(res, 404, notFoundPage());
  } catch (err) {
    const { status, message } = errorStatus(err);
    if (res.headersSent) return res.end();
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: message });
    else sendHtml(res, status, notFoundPage());
  }
});

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  server.listen(config.port, () => {
    console.log(`Quorum running on ${config.baseUrl}`);
    console.log('Modes:', describeModes());
  });
  // In-process settlement loop. On Render, the cron job also calls /api/cron/settle.
  const timer = setInterval(() => settleDue().catch((e) => console.error('[settle]', e)), config.quorum.settleIntervalSeconds * 1000);
  timer.unref();
}
