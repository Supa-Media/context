/**
 * `activity.md`, from the control plane's side.
 *
 * The gateway records what an AI client changed. This records what a *person*
 * changed in the console — and the meeting that asked for this feature asked
 * for both in one list: "ChatGPT changed this and Claude changed this, but you
 * don't really see it", and, in the same breath, "how does Shay even know that
 * this meeting note is here". A feed carrying only half of the hands that touch
 * a context would answer neither question.
 *
 * Both sides build their entries with `packages/shared/src/activity.cjs`, which
 * owns the format, the substance rules and the grouping. Nothing about what an
 * entry *is* lives here; what lives here is the read-modify-write against the
 * customer's bucket, and the rule that the file stays private.
 *
 * Everything is swallowed. A note save that succeeded must never be reported
 * as failed because its footnote did not land — the same rule, and the same
 * reasoning, as the gateway's `recordActivity`.
 */

import {
  ACTIVITY_PATH,
  mayBeReportable,
  nextFile as nextActivityFile,
  parseFile as parseActivityFile,
  visibleEntries as visibleActivityEntries,
} from "@context/shared/src/activity.cjs";

import {
  canSee,
  effectiveVisibility,
  type PrivacyRule,
  type Visibility,
} from "./privacy";
import { loadPrivacyState, setExactVisibility, type FileStore } from "./fileOps";

export { ACTIVITY_PATH };

export interface ActivityActor {
  /** The acting person's `@name`, or null where a scheduled pass acted. */
  name: string | null;
  /** The client they acted through. Null for the console: it is their own hand. */
  client: string | null;
}

export interface ActivityChange {
  action: string;
  paths: string[];
  details: Record<string, string | number | boolean | null | undefined>;
  actor: ActivityActor | null;
}

/**
 * Record one change, if it is one worth recording.
 *
 * `team_visible` is re-derived here rather than trusted from the caller,
 * because it is the flag the whole privacy story rests on: an entry written
 * `team` about a private note would be readable by every member of the
 * workspace for as long as the file keeps it. The manifest read it needs is
 * the one `loadPrivacyState` already caches per store.
 */
export async function recordActivity(
  store: FileStore,
  change: ActivityChange,
): Promise<void> {
  try {
    if (!mayBeReportable(change.action, change.paths)) return;
    const privacy = await loadPrivacyState(store);
    if (privacy.invalid || privacy.text === null) return;
    const teamVisible = change.paths.every(
      (path) =>
        effectiveVisibility(path, privacy.rules, privacy.overrides) === "team",
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await store.get(ACTIVITY_PATH);
      const current = existing ? await existing.text() : "";
      const next = nextActivityFile(current, {
        action: change.action,
        paths: change.paths,
        details: { ...change.details, team_visible: teamVisible },
        actor: change.actor,
        at: new Date().toISOString(),
      });
      if (!next) return;
      const conditional =
        existing === null
          ? store.capabilities?.conditionalCreate === true
            ? { absent: true as const }
            : null
          : store.capabilities?.conditionalWrite === true
            ? { etagMatches: existing.etag }
            : null;
      const put = conditional
        ? await store.put(ACTIVITY_PATH, next.text, { onlyIf: conditional })
        : await store.put(ACTIVITY_PATH, next.text);
      if (put === null) continue;
      /*
        Private, checked rather than assumed — the gateway's copy carries the
        reasoning. The case this is for is a hand-written note override
        publishing the file, which would hand every member an index of every
        private filename in the context. Costs nothing in the ordinary case:
        the manifest is already loaded above, and the writer no-ops when the
        answer is already private.
      */
      if (
        effectiveVisibility(ACTIVITY_PATH, privacy.rules, privacy.overrides) !== "private"
      ) {
        await setExactVisibility(store, ACTIVITY_PATH, "private");
      }
      return;
    }
  } catch {
    // A change is never failed by its own footnote.
  }
}

export interface ActivityEntry {
  at: string;
  kind: string;
  paths: string[];
  n: number;
  vis: "team" | "private";
  by: string | null;
  via: string | null;
  note: string | null;
}

/**
 * The entries one reader may see, newest first.
 *
 * The viewing layer the console draws its rows from. Two gates, the same two
 * the gateway applies: the flag recorded when the change happened, and
 * `canSee` re-derived through the live manifest now. An entry that fails
 * either is absent — never greyed, never counted.
 */
export async function readActivity(
  store: FileStore,
  reader: { scope: "private" | "team"; names?: readonly string[] },
): Promise<ActivityEntry[]> {
  const object = await store.get(ACTIVITY_PATH);
  if (!object) return [];
  const privacy = await loadPrivacyState(store);
  const rules: PrivacyRule[] = privacy.invalid ? [] : privacy.rules;
  const overrides: Map<string, Visibility> = privacy.invalid
    ? new Map()
    : privacy.overrides;
  const names = reader.names ? new Set(reader.names) : undefined;
  return visibleActivityEntries(parseActivityFile(await object.text()), {
    owner: reader.scope === "private",
    canSee: (path: string) => canSee(path, reader.scope, rules, overrides, names),
  }) as ActivityEntry[];
}
