// In-process pub/sub so pages can follow a group live (Server-Sent Events).
// One process serves the app, so no broker is needed.
type Listener = () => void;
const subscribers = new Map<string, Set<Listener>>();

export function subscribe(quorumId: string, fn: Listener): () => void {
  let set = subscribers.get(quorumId);
  if (!set) subscribers.set(quorumId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) subscribers.delete(quorumId);
  };
}

/** Tell every open page that this group changed. */
export function publish(quorumId: string) {
  for (const fn of subscribers.get(quorumId) ?? []) {
    try {
      fn();
    } catch {
      // a broken connection must never interrupt settlement
    }
  }
}
