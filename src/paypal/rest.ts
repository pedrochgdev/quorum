// Real PayPal REST client (Orders v2, Payments v2, Payouts v1, Webhooks).
// Two-step payments: authorize at checkout, capture or void when the group closes.
import { config } from '../config.ts';
import { amountString } from '../util.ts';
import {
  PayPalError,
  type AuthorizationResult,
  type CaptureResult,
  type CreateOrderInput,
  type OrderResult,
  type PayPalProvider,
  type PayoutItem,
} from './types.ts';

export const paypalBaseUrl = () =>
  process.env.PAYPAL_API_BASE || // test hook: point at a local PayPal stub
  (config.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

let token: { value: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const { clientId, clientSecret } = config.paypal;
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new PayPalError('PayPal OAuth failed', res.status, body);
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3000) * 1000 };
  return token.value;
}

export async function paypalFetch<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; requestId?: string; prefer?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
  };
  // Idempotency: PayPal returns the original result when a request id repeats.
  if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${paypalBaseUrl()}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(`PayPal ${opts.method ?? 'GET'} ${path} failed (${res.status})`, res.status, json);
  return json as T;
}

const amountOf = (a: { value?: string } | undefined) => Number(a?.value ?? 0);

export class RestPayPal implements PayPalProvider {
  readonly name = 'paypal' as const;

  async createOrder(input: CreateOrderInput): Promise<OrderResult> {
    const order = await paypalFetch('/v2/checkout/orders', {
      method: 'POST',
      requestId: input.requestId,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: input.referenceId,
            custom_id: input.customId,
            description: input.description.slice(0, 127),
            amount: { currency_code: input.currency, value: amountString(input.amount) },
            ...(input.payeeEmail ? { payee: { email_address: input.payeeEmail } } : {}),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Quorum',
              user_action: 'CONTINUE',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${config.baseUrl}/q/${input.referenceId}`,
              cancel_url: `${config.baseUrl}/q/${input.referenceId}`,
            },
          },
        },
      },
    });
    const approve = (order.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    return { id: order.id, status: order.status, approveUrl: approve?.href };
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    const order = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
      method: 'POST',
      requestId,
      prefer: 'return=representation',
      body: {},
    });
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError('Authorization missing from PayPal response', 500, order);
    return {
      authorizationId: auth.id,
      status: auth.status,
      amount: amountOf(auth.amount),
      expirationTime: auth.expiration_time,
      payerEmail: order.payer?.email_address ?? order.payment_source?.paypal?.email_address,
      payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ') || undefined,
    };
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationResult> {
    const auth = await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
    return { authorizationId: auth.id, status: auth.status, amount: amountOf(auth.amount), expirationTime: auth.expiration_time };
  }

  async captureAuthorization(authorizationId: string, amount: number, currency: string, requestId: string): Promise<CaptureResult> {
    // Capturing less than the authorized amount is allowed; final_capture releases the rest.
    const cap = await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
      method: 'POST',
      requestId,
      prefer: 'return=representation',
      body: {
        amount: { currency_code: currency, value: amountString(amount) },
        final_capture: true,
        note_to_payer: 'Your Quorum group formed. You paid the group price.',
      },
    });
    return { captureId: cap.id, status: cap.status, amount: amountOf(cap.amount) || amount };
  }

  async voidAuthorization(authorizationId: string, requestId: string) {
    await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
      method: 'POST',
      requestId,
    });
    return { status: 'VOIDED' };
  }

  async reauthorize(authorizationId: string, amount: number, currency: string, requestId: string): Promise<AuthorizationResult> {
    const auth = await paypalFetch(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`, {
      method: 'POST',
      requestId,
      prefer: 'return=representation',
      body: { amount: { currency_code: currency, value: amountString(amount) } },
    });
    return { authorizationId: auth.id, status: auth.status, amount: amountOf(auth.amount), expirationTime: auth.expiration_time };
  }

  async refundCapture(captureId: string, amount: number, currency: string, requestId: string) {
    const r = await paypalFetch(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      requestId,
      body: { amount: { currency_code: currency, value: amountString(amount) } },
    });
    return { refundId: r.id, status: r.status };
  }

  async createPayout(items: PayoutItem[], currency: string, requestId: string) {
    const r = await paypalFetch('/v1/payments/payouts', {
      method: 'POST',
      requestId,
      body: {
        sender_batch_header: {
          sender_batch_id: requestId,
          email_subject: 'You earned a Quorum referral reward',
          email_message: 'Thanks for growing your group.',
        },
        items: items.map((i) => ({
          recipient_type: 'EMAIL',
          receiver: i.email,
          note: i.note,
          sender_item_id: i.senderItemId,
          amount: { currency, value: amountString(i.amount) },
        })),
      },
    });
    return { batchId: r.batch_header?.payout_batch_id ?? '', status: r.batch_header?.batch_status ?? 'PENDING' };
  }
}

/** Verify a webhook with PayPal's verify-webhook-signature endpoint. */
export async function verifyWebhookSignature(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
  if (!config.paypal.webhookId) return false;
  const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
  const res = await paypalFetch<{ verification_status: string }>('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    },
  });
  return res.verification_status === 'SUCCESS';
}
