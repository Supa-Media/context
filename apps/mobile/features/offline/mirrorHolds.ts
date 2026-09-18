import { getDraft, getOutbox } from "./cache";
import { parseKey } from "./keys";
import type { KeyValueStore } from "./memory";
import type { Needed } from "./mirror";

/**
 * Which versions of which notes somebody's unsaved work is based on — the
 * answer `mirror.ts`'s ancestor rule asks before it replaces a body.
 *
 * Three sources, because there are three places typing lives, and the store
 * alone trails two of them:
 *
 *  - **The queue on the device** (`outbox` records): every entry's `baseEtag`,
 *    which is the version a conflict on it will need to merge against.
 *  - **Drafts on the device**: the same, for text typed and never saved.
 *  - **Holds, in memory**: what the running console has not written down yet.
 *    The open context's queue is persisted up to `PERSIST_DEBOUNCE_MS` behind
 *    the live one (`useOfflineNotes`), a draft is written on a throttle, and a
 *    note merely *open* in the editor has a base the moment somebody types —
 *    which may be ten minutes after a sync moved the mirror on. Without the
 *    hold, that sync would take the ancestor of a draft that does not exist
 *    yet; the read cache never had this problem only because nothing
 *    overwrote a copy nobody reopened.
 *
 * A hold is keyed by an owner, so the one component that set it replaces it
 * wholesale and removes it on unmount, and two owners cannot erase each
 * other's. It holds paths and etags: never text.
 */

type Holds = Map<string, Map<string, Set<string>>>;

const holds = new Map<string, Holds>();

/**
 * Replace everything `owner` holds with `byPath`, for one workspace.
 * `null`/`undefined` etags are ignored, so a caller can pass an editor's
 * fields as they are.
 */
export function holdAncestors(
  owner: string,
  workspaceId: string | null,
  byPath: Readonly<Record<string, readonly (string | null | undefined)[]>>,
): void {
  const mine: Holds = new Map();
  if (workspaceId !== null) {
    const paths = new Map<string, Set<string>>();
    for (const [path, etags] of Object.entries(byPath)) {
      const kept = new Set(etags.filter((etag): etag is string => typeof etag === "string"));
      if (kept.size > 0) paths.set(path, kept);
    }
    if (paths.size > 0) mine.set(workspaceId, paths);
  }
  if (mine.size === 0) holds.delete(owner);
  else holds.set(owner, mine);
}

export function releaseAncestors(owner: string): void {
  holds.delete(owner);
}

/** Every etag some local work in `workspaceId` is based on, as a `Needed`. */
export async function neededEtags(kv: KeyValueStore, workspaceId: string): Promise<Needed> {
  const found = new Map<string, Set<string>>();
  const add = (path: string, etag: string | null | undefined) => {
    if (typeof etag !== "string") return;
    let set = found.get(path);
    if (set === undefined) {
      set = new Set();
      found.set(path, set);
    }
    set.add(etag);
  };

  for (const owned of holds.values()) {
    for (const [path, etags] of owned.get(workspaceId) ?? []) {
      for (const etag of etags) add(path, etag);
    }
  }
  try {
    for (const write of (await getOutbox(kv, workspaceId)).writes) add(write.path, write.baseEtag);
    for (const key of await kv.keys()) {
      const parsed = parseKey(key);
      if (parsed?.kind !== "draft" || parsed.workspaceId !== workspaceId) continue;
      const draft = await getDraft(kv, workspaceId, parsed.path);
      if (draft !== null) add(draft.path, draft.baseEtag);
    }
  } catch {
    /*
      A store that cannot be listed cannot say which ancestors are needed.
      Answer with what the holds said rather than failing the caller: the
      direction this can be wrong in is a merge refused with "moved on", which
      is reported, never a merge made against the wrong ancestor — `offerMerge`
      still checks the etag.
    */
  }
  return (path) => found.get(path) ?? new Set();
}
