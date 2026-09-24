import type { PresenceMember } from "./protocol";

/** A peer, as the drawing editor needs one: a name, a colour, and a pointer. */
export interface PeerPointer {
  id: string;
  name: string;
  color: string | null;
  x: number;
  y: number;
  selected: string[];
}

/**
 * The roster and the pointers, joined.
 *
 * Two sources because they change at different rates and for different
 * reasons: who is here arrives on `welcome`/`join`/`leave` and belongs in
 * React state, while where their pointer is arrives on every mouse move and
 * must not. A peer with no pointer yet is simply not in the answer — drawing
 * a cursor at the origin would be a claim about where somebody is, and a
 * wrong one.
 */
export function peersFrom(
  members: PresenceMember[],
  pointers: Map<string, { x: number; y: number; selected: string[] }>,
): PeerPointer[] {
  const out: PeerPointer[] = [];
  for (const member of members) {
    const at = pointers.get(member.id);
    if (!at) continue;
    out.push({
      id: member.id,
      name: member.name,
      color: member.color,
      x: at.x,
      y: at.y,
      selected: at.selected,
    });
  }
  return out;
}

/**
 * A colour seed that survives a reload but not a new tab.
 *
 * The same person in two tabs is two members — which is true — and each keeps
 * its colour across reconnects and refreshes. `sessionStorage` can throw in a
 * private window, so a failure falls back to a per-mount value rather than
 * taking the feature down with it.
 */
export function tabSeed(): string {
  const key = "context.presence.seed";
  try {
    const held = window.sessionStorage.getItem(key);
    if (held) return held;
    const minted = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.sessionStorage.setItem(key, minted);
    return minted;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}
