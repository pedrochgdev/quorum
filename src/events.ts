import { all, run } from './db.ts';
import { nowIso } from './util.ts';

export function recordEvent(type: string, source: string, refId: string | null, payload: unknown) {
  run(
    'INSERT INTO events (type, source, ref_id, payload_json, created_at) VALUES (?,?,?,?,?)',
    type, source, refId, JSON.stringify(payload ?? {}), nowIso(),
  );
}

/** Every agent decision is logged with its reason, so it can be audited and shown. */
export function logAgent(agent: string, refId: string | null, decision: string, reason: string, engine: string) {
  run(
    'INSERT INTO agent_log (agent, ref_id, decision, reason, engine, created_at) VALUES (?,?,?,?,?,?)',
    agent, refId, decision, reason, engine, nowIso(),
  );
}

export const recentEvents = (limit = 50) =>
  all<{ id: number; type: string; source: string; ref_id: string; payload_json: string; created_at: string }>(
    'SELECT * FROM events ORDER BY id DESC LIMIT ?', limit,
  );

export const agentLogFor = (refId: string) =>
  all<{ agent: string; decision: string; reason: string; engine: string; created_at: string }>(
    'SELECT agent, decision, reason, engine, created_at FROM agent_log WHERE ref_id = ? ORDER BY id', refId,
  );
