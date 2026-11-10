// Buyer notifications. Every message is written to an outbox table first, so
// the demo can show what was sent. With RESEND_API_KEY set, the same message
// is emailed through Resend's REST API (https://resend.com/docs/api-reference).
import { config } from './config.ts';
import { all, run } from './db.ts';
import { nowIso } from './util.ts';

export type NotificationKind = 'joined' | 'closed' | 'failed' | 'refund' | 'matched' | 'left';

const isDeliverable = (email: string) => !/@example\.(com|org|net)$/i.test(email) && !/@(personal|business)\.example\.com$/i.test(email);

export function notify(email: string | null | undefined, kind: NotificationKind, subject: string, body: string, quorumId: string | null = null) {
  if (!email) return;
  const willSend = Boolean(config.notify.resendApiKey) && isDeliverable(email);
  const row = run(
    'INSERT INTO notifications (email, kind, subject, body, quorum_id, status, created_at) VALUES (?,?,?,?,?,?,?)',
    email, kind, subject, body, quorumId, willSend ? 'sending' : 'recorded', nowIso(),
  );
  if (!willSend) return;
  const id = Number(row.lastInsertRowid);
  // Fire and forget: a slow mail API must not hold up settlement.
  void fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.notify.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.notify.from, to: [email], subject, text: body }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => run('UPDATE notifications SET status = ? WHERE id = ?', res.ok ? 'sent' : `failed (${res.status})`, id))
    .catch((err) => run('UPDATE notifications SET status = ? WHERE id = ?', `failed (${String((err as Error).message).slice(0, 60)})`, id));
}

export const recentNotifications = (quorumId: string | null, limit = 30) =>
  quorumId
    ? all<{ id: number; email: string; kind: string; subject: string; body: string; status: string; created_at: string }>(
        'SELECT id, email, kind, subject, body, status, created_at FROM notifications WHERE quorum_id = ? ORDER BY id DESC LIMIT ?', quorumId, limit,
      )
    : all<{ id: number; email: string; kind: string; subject: string; body: string; status: string; created_at: string }>(
        'SELECT id, email, kind, subject, body, status, created_at FROM notifications ORDER BY id DESC LIMIT ?', limit,
      );

/** Short bilingual copy for the messages buyers receive. */
export function copy(lang: string, kind: NotificationKind, v: Record<string, string>): { subject: string; body: string } {
  const es = lang === 'es';
  switch (kind) {
    case 'joined':
      return es
        ? { subject: `Estás dentro: ${v.product}`, body: `PayPal retiene ${v.amount} y no te cobró nada. Si el grupo se forma pagas el precio final del grupo, nunca más de ${v.amount}. Si no se forma, la retención se libera.\n\n${v.link}` }
        : { subject: `You're in: ${v.product}`, body: `PayPal is holding ${v.amount} and charged nothing. If the group forms you pay the final group price, never more than ${v.amount}. If it doesn't, the hold is released.\n\n${v.link}` };
    case 'closed':
      return es
        ? { subject: `Tu grupo se formó: pagaste ${v.paid}`, body: `${v.product}: el grupo cerró con ${v.members} compradores. Autorizaste ${v.amount} y PayPal cobró ${v.paid}.\n\n${v.link}` }
        : { subject: `Your group formed: you paid ${v.paid}`, body: `${v.product}: the group closed with ${v.members} buyers. You authorized ${v.amount} and PayPal captured ${v.paid}.\n\n${v.link}` };
    case 'failed':
      return es
        ? { subject: `El grupo no se formó: no se te cobró`, body: `${v.product}: el grupo no llegó a su meta. PayPal liberó tu autorización de ${v.amount}.\n\n${v.link}` }
        : { subject: `The group did not form: you were not charged`, body: `${v.product}: the group did not reach its goal. PayPal released your ${v.amount} authorization.\n\n${v.link}` };
    case 'refund':
      return es
        ? { subject: `El precio bajó: te devolvimos ${v.refund}`, body: `${v.product}: entraron más compradores después del cierre y el grupo alcanzó un precio menor. PayPal te devolvió ${v.refund}; tu precio final es ${v.paid}.\n\n${v.link}` }
        : { subject: `The price dropped: ${v.refund} refunded`, body: `${v.product}: more buyers joined after the close and the group reached a cheaper tier. PayPal refunded ${v.refund}; your final price is ${v.paid}.\n\n${v.link}` };
    case 'matched':
      return es
        ? { subject: `Un comercio abrió un grupo para tu pedido`, body: `${v.product}: ya hay un grupo que coincide con lo que pediste. Únete sin pagar hasta que se forme.\n\n${v.link}` }
        : { subject: `A merchant opened a group for your request`, body: `${v.product}: there is now a group that matches what you asked for. Join without paying until it forms.\n\n${v.link}` };
    case 'left':
      return es
        ? { subject: `Saliste del grupo`, body: `${v.product}: PayPal liberó tu autorización de ${v.amount}. No se te cobró nada.\n\n${v.link}` }
        : { subject: `You left the group`, body: `${v.product}: PayPal released your ${v.amount} authorization. Nothing was charged.\n\n${v.link}` };
  }
}
