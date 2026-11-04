// PayPal webhooks: verify the signature, log the event, and keep commitment
// state in sync (for example, an authorization PayPal voided on expiry).
import { config } from '../config.ts';
import { get, run } from '../db.ts';
import { recordEvent } from '../events.ts';
import type { Commitment } from '../models.ts';
import { nowIso } from '../util.ts';
import { verifyWebhookSignature } from './rest.ts';

type WebhookEvent = { id?: string; event_type?: string; resource?: any };

export async function handlePayPalWebhook(headers: Record<string, string | undefined>, event: WebhookEvent) {
  if (config.paypal.mode === 'mock') return { ok: false, reason: 'webhooks are disabled in mock mode' };
  const verified = await verifyWebhookSignature(headers, event).catch(() => false);
  if (!verified) {
    recordEvent('webhook.rejected', 'paypal', event.id ?? null, { type: event.event_type });
    return { ok: false, reason: 'signature verification failed' };
  }
  recordEvent(event.event_type ?? 'unknown', 'paypal', event.resource?.id ?? null, event);
  applyEvent(event);
  return { ok: true };
}

export function applyEvent(event: WebhookEvent) {
  const r = event.resource ?? {};
  const related = r.supplementary_data?.related_ids ?? {};
  const byAuth = (id?: string) => (id ? get<Commitment>('SELECT * FROM commitments WHERE authorization_id = ?', id) : undefined);
  const byOrder = (id?: string) => (id ? get<Commitment>('SELECT * FROM commitments WHERE paypal_order_id = ?', id) : undefined);
  const t = nowIso();
  switch (event.event_type) {
    case 'PAYMENT.AUTHORIZATION.CREATED': {
      const c = byOrder(related.order_id);
      if (c && c.status === 'created') {
        run("UPDATE commitments SET status = 'authorized', authorization_id = ?, authorized_at = ?, updated_at = ? WHERE id = ?", r.id, t, t, c.id);
      }
      break;
    }
    case 'PAYMENT.AUTHORIZATION.VOIDED': {
      const c = byAuth(r.id);
      if (c && c.status === 'authorized') {
        run("UPDATE commitments SET status = 'voided', failure_reason = 'voided by PayPal', updated_at = ? WHERE id = ?", t, c.id);
      }
      break;
    }
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const c = byAuth(related.authorization_id);
      if (c && c.status !== 'captured') {
        run("UPDATE commitments SET status = 'captured', capture_id = ?, captured_amount = ?, updated_at = ? WHERE id = ?", r.id, Number(r.amount?.value ?? 0), t, c.id);
      }
      break;
    }
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED': {
      const c = byAuth(related.authorization_id);
      if (c && c.status !== 'failed') {
        run("UPDATE commitments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", event.event_type, t, c.id);
      }
      break;
    }
  }
}
