import { parseKey, type CacheScope } from "../../offline/keys";
import type { KeyValueStore } from "../../offline/memory";
import { DurableCollaborationController, type CollaborationTransport, type DurableStatus } from "./durable";
import { sendInBackground } from "./noteLease";

/**
 * Sending what a closed shared note left on this device.
 *
 * A shared note's unsent typing lives in its durable record: Yjs updates the
 * bucket has not confirmed, or an offline draft (`offlineDraft.ts`). Only the
 * note's controller sends them, and that controller lived only while the
 * editor had the note open, so an edit made offline in a note that was then
 * closed stayed on the phone until somebody opened that note again.
 *
 * This runs the same controller with no editor, once per reconnection, for
 * every record with something to send that no editor holds (`noteLease.ts`),
 * one note at a time. There is no second write path: the controller sends
 * exactly what it would have sent with the note open. An older draft kept for
 * review (a recovery not typed as an offline draft) is left for the editor.
 */

export interface ClosedNotesDeps {
  /** A gateway transport for the workspace the record is filed under, never the one on screen. */
  transport: (workspaceId: string) => CollaborationTransport;
  /** Whether this session still owns the device; checked before every note. */
  mine: () => boolean;
  online: () => boolean;
  /** How long one note may take before it is left for the next reconnection. */
  settleMs?: number;
}

/** What one pass did: notes whose typing reached the bucket, and notes still holding some. */
export interface ClosedNotesReport {
  sent: number;
  left: number;
}

const SETTLE_MS = 20_000;
const GAVE_UP: ReadonlySet<DurableStatus> = new Set(["offline", "error", "unavailable", "revoked"]);

interface Kept {
  pending?: unknown[];
  recovery?: { desired?: unknown; offline?: unknown };
}

/** The record's draft text, `""` for unsent updates only, or `null` when it has nothing to send here. */
function unsent(raw: string | null): string | null {
  if (raw === null) return null;
  let kept: Kept;
  try {
    kept = JSON.parse(raw) as Kept;
  } catch {
    return null;
  }
  if (kept.recovery !== undefined) {
    return kept.recovery.offline === true && typeof kept.recovery.desired === "string" ? kept.recovery.desired : null;
  }
  return Array.isArray(kept.pending) && kept.pending.length > 0 ? "" : null;
}

export async function sendClosedNotes(store: KeyValueStore, deps: ClosedNotesDeps): Promise<ClosedNotesReport> {
  const report: ClosedNotesReport = { sent: 0, left: 0 };
  if (!deps.online()) return report;
  let keys: string[];
  try {
    keys = await store.keys();
  } catch {
    return report;
  }
  for (const key of keys) {
    if (!deps.mine() || !deps.online()) break;
    const parsed = parseKey(key);
    // A superseded record is an earlier note's, kept aside on purpose.
    if (parsed?.kind !== "collaboration" || parsed.scope === null || parsed.path.includes("::superseded::")) continue;
    let draft: string | null;
    try {
      draft = unsent(await store.get(key));
    } catch {
      continue;
    }
    if (draft === null) continue;
    const outcome = await sendOne(store, key, parsed.workspaceId, parsed.path, parsed.scope, draft, deps);
    if (outcome === "sent") report.sent += 1;
    else if (outcome === "left") report.left += 1;
  }
  return report;
}

async function sendOne(
  store: KeyValueStore,
  key: string,
  workspaceId: string,
  path: string,
  scope: CacheScope,
  draft: string,
  deps: ClosedNotesDeps,
): Promise<"sent" | "left" | "open"> {
  let finish: (outcome: "sent" | "left") => void = () => {};
  const done = new Promise<"sent" | "left">((resolve) => {
    finish = resolve;
  });
  const controller = new DurableCollaborationController({
    workspaceId,
    path,
    scope,
    initialText: draft,
    transport: deps.transport(workspaceId),
    store,
    onText: () => {},
    onState: (state) => {
      if (state.status === "saved" && state.pending === 0 && state.recovery === undefined) finish("sent");
      else if (GAVE_UP.has(state.status)) finish("left");
    },
    online: deps.online,
    background: true,
  });
  const release = sendInBackground(key, async () => {
    // Opened meanwhile: the editor's controller takes it from here.
    finish("left");
    controller.stop();
    await controller.settled();
  });
  if (release === null) {
    controller.stop();
    return "open";
  }
  const deadline = setTimeout(() => finish("left"), deps.settleMs ?? SETTLE_MS);
  void controller.start().catch(() => finish("left"));
  const outcome = await done;
  clearTimeout(deadline);
  controller.stop();
  await controller.settled();
  release();
  return outcome;
}
