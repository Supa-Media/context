/**
 * `recordChange` — the one call every write makes afterwards: the activity
 * file entry, the audit trail, and the tree-change announcement to whoever
 * can see the path.
 */

/**
 * The activity file's format, shared with the control plane.
 *
 * The gateway records what an AI client does; the console records what a
 * person does; both append to one file in the customer's bucket. Two copies of
 * "what counts as a change worth mentioning" would drift within a month, so
 * the rules live in `packages/shared` — the same arrangement `storageLayout`
 * already has, and for the same reason. It is `.cjs` because this Worker
 * cannot import the package's TypeScript (see `packages/shared/src/links.ts`).
 */
import { ACTIVITY_PATH, mayBeReportable as mayBeActivity, nextFile as nextActivityFile } from "../../../../packages/shared/src/activity.cjs";
import { AUDIT_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { effectiveVisibility, GROUP_SCOPE_PATTERN, isPlumbing } from "../privacy/engine.js";
import { generatedCollaborationBase, writeGeneratedNote } from "../notes/sealing.js";
import { loadPrivacyState, persistExactVisibility } from "../privacy/state.js";
import { timestampSlug } from "../notes/paths.js";
import { TREE_ACTIONS, treeHintOf } from "./changes.js";

export async function recordChange(store, action, actorScope, paths, details = {}) {
  const at = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry = { at, action, actor_scope: actorScope, paths, details };
  // Who, not just what tier. `actor_scope: "team"` is useless once "team" is
  // four people and one of them wants to know which of their colleagues — or
  // which of their AI clients — moved a note.
  if (store.actor) {
    entry.actor_user_id = store.actor.userId;
    entry.actor_client_id = store.actor.clientId;
    entry.workspace_id = store.actor.workspaceId;
  }
  await store.put(`${AUDIT_PREFIX}${timestampSlug(new Date(at))}-${id}.json`, JSON.stringify(entry));
  await recordActivity(store, { action, paths, details, at });
  announceTreeChange(store, action, paths, details);
  announceWebsiteChange(store, paths);
}

/**
 * Who may be told the tree changed. The gateway's copy of
 * `apps/convex/functions/lib/treeAudiences.ts`, over this engine's own
 * `effectiveVisibility` — see that file for the reasoning: a timestamp served
 * to somebody who cannot see a change would date it for them.
 */
function treeAudiencesOf(paths, known, rules, overrides) {
  const audiences = new Set();
  const reach = (visibility) => {
    if (visibility === "team" || GROUP_SCOPE_PATTERN.test(visibility)) audiences.add(visibility);
  };
  for (const raw of paths) {
    const path = String(raw).replace(/\/+$/, "");
    if (path === "" || isPlumbing(path)) continue;
    audiences.add("private");
    reach(effectiveVisibility(path, rules, overrides));
    const under = `${path}/`;
    for (const rule of rules) if (rule.prefix.startsWith(under)) reach(rule.vis);
    for (const [key, visibility] of overrides) if (key.startsWith(under)) reach(visibility);
  }
  for (const visibility of known) {
    audiences.add("private");
    reach(visibility);
  }
  return [...audiences].sort();
}

/**
 * Tell the consoles showing this context that its tree changed — deferred,
 * best-effort, and never able to fail the change, exactly as `reportActivity`
 * is. Only a session-bound store has a reporter; see `reportTreeChange`.
 */
function announceTreeChange(store, action, paths, details) {
  if (!TREE_ACTIONS.has(action) || typeof store.reportTreeChange !== "function") return;
  const work = (async () => {
    const hint = treeHintOf(action, Array.isArray(paths) ? paths : [], details);
    const state = await loadPrivacyState(store);
    if (state.error) return;
    const audiences = treeAudiencesOf(hint.paths, hint.known, state.rules, state.overrides);
    if (audiences.length > 0) await store.reportTreeChange(audiences);
  })().catch(() => {});
  if (typeof store.defer !== "function") return;
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
}

/**
 * The published folder, as the control plane spells it.
 *
 * Restated here rather than imported: this Worker's only runtime dependency is
 * `@context/collaboration`, so it cannot reach `@context/shared`, and the
 * control-plane copy is `websites/changes.ts`. The same restatement
 * `features/site/host.ts` makes of the router's `isPlatformHost`, for the same
 * reason.
 */
const WEBSITE_ROOT = "website";

function touchesWebsite(path) {
  const normalized = String(path).replace(/^\/+|\/+$/g, "");
  return normalized === WEBSITE_ROOT || normalized.startsWith(`${WEBSITE_ROOT}/`);
}

/**
 * Tell the control plane its route index no longer describes the bucket.
 *
 * ## Why this is not folded into `announceTreeChange`
 *
 * That one is gated on `TREE_ACTIONS`, a whitelist of changes to the *shape*
 * of the tree, and it is right to be: editing a note's body moves nothing.
 * The website index is a derivative of the bytes, so the case it most needs to
 * hear about is exactly the one that list leaves out — `update_note`, which is
 * both an MCP client rewriting a page's frontmatter and a live editing session
 * flushing one. It also judges a move by its destination alone, and a page
 * moved *out* of the folder has to invalidate too. So this reads the raw paths
 * and asks one question of them.
 *
 * **Both ends, and only this folder.** The control plane rebuilds the whole
 * index when it hears this, and since that scan reads every published page,
 * reporting an ordinary note write would be a full scan after every save.
 *
 * Deferred, best-effort and unable to fail the change, like its neighbours: a
 * missed report costs the freshness the quarter-hourly sweep restores.
 */
function announceWebsiteChange(store, paths) {
  if (typeof store.reportWebsiteChange !== "function") return;
  if (!Array.isArray(paths) || !paths.some(touchesWebsite)) return;
  const work = Promise.resolve(store.reportWebsiteChange()).catch(() => {});
  if (typeof store.defer !== "function") return;
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
}

/**
 * The same change again, as a line in a note somebody reads.
 *
 * ## Why this is a second write and not a rendering of the first
 *
 * `.context/audit/` is one object per change, which is the right shape for a
 * record that must never be rewritten and the wrong shape for a list somebody
 * opens: answering "what happened this week" from it means listing and reading
 * hundreds of small objects, which is what `list_changes` does and why it is
 * slow enough to be an agent's tool rather than a screen's. `activity.md` is
 * the same facts kept in the shape a reader wants, and it is a *note* — in the
 * customer's bucket, in Markdown, openable in Obsidian, carried out by any
 * export — because a feed that only exists inside our console is a feed we
 * have taken custody of.
 *
 * It is a derivative, and it is allowed to be lossy: what falls off the end of
 * the file is still in the audit trail, and the file can be rebuilt from it.
 *
 * ## It may never fail a change
 *
 * A note write that succeeded and then reported failure because its footnote
 * did not land is a worse outcome than a missing line, every time. Everything
 * here is inside a catch, and the only consequence of a failure is that the
 * line is absent.
 *
 * ## Private at rest, whatever folder it sits in
 *
 * The file names paths from every corner of the context, so it is stored
 * `private` on every write — the ACL is re-asserted rather than assumed,
 * because a folder default that later turns `team` must not quietly hand a
 * member the owner's index of private filenames. What a member gets instead is
 * `read_activity`, which renders the lines they may see. Both halves are
 * proven in `test/activity.test.mjs`.
 */
async function recordActivity(store, change) {
  try {
    // Before the read, not after it. Most changes are not reportable at all —
    // a proposal, a sync job's arrival, a write under `.context/` — and the
    // expensive half of recording one is the read that used to happen before
    // this question was asked.
    if (!mayBeActivity(change.action, change.paths)) return;
    const actor = store.actor
      ? { name: store.actor.name || null, client: store.actor.client || null }
      : null;
    // Two attempts, not a loop. The second is for the ordinary race — two
    // clients writing notes in the same second — and a third would be a queue
    // this file has no business growing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await store.get(ACTIVITY_PATH);
      const stored = existing ? await existing.text() : "";
      let collaborationBase = null;
      try {
        collaborationBase = existing
          ? await generatedCollaborationBase(store, ACTIVITY_PATH, stored)
          : null;
      } catch {
        continue;
      }
      const current = collaborationBase?.text ?? stored;
      const next = nextActivityFile(current, { ...change, actor });
      // The common answer: nothing substantial, or a line that already says it.
      if (!next) return;
      // The activity file names private paths and is always private. Validate
      // and tighten that ACL before either write authority commits its bytes.
      const state = await loadPrivacyState(store);
      if (
        !state.error &&
        effectiveVisibility(ACTIVITY_PATH, state.rules, state.overrides) !== "private"
      ) {
        await persistExactVisibility(store, ACTIVITY_PATH, "private", state.rules);
      }
      const conditional =
        existing === null
          ? store.capabilities?.conditionalCreate === true
            ? { absent: true }
            : null
          : store.capabilities?.conditionalWrite === true
            ? { etagMatches: existing.etag }
            : null;
      let put;
      try {
        put = collaborationBase
          ? await writeGeneratedNote(store, ACTIVITY_PATH, next.text, collaborationBase)
          : conditional
            ? await store.put(ACTIVITY_PATH, next.text, { onlyIf: conditional })
            : await store.put(ACTIVITY_PATH, next.text);
      } catch {
        continue;
      }
      if (put === null) continue;
      /*
        THE FILE IS PRIVATE, AND THAT IS CHECKED RATHER THAN ASSUMED.

        `privacy.md`'s format requires `default_visibility: private`, so a file
        at the root inherits private in every manifest that parses — which is
        why this costs nothing in the ordinary case and reads as belt to that
        brace. The case it is actually for is the one a person can create by
        hand: an exact-note override publishing `activity.md` to the team,
        typed into the manifest in Obsidian, which would hand every member an
        index of every private filename in the context.

        Re-asserted on any write that finds it published rather than only on
        creation, because a file published after it existed is exactly the
        shape a create-time check misses. The manifest is read only here, on a
        write that is actually happening — never on the common path, where
        `nextActivityFile` has already decided there is nothing to say.
      */
      /*
        Across the boundary: this context changed, at this tier. It is what
        lights the dot on this workspace's mark in somebody else's console, and
        it carries nothing about *what* changed — see `reportActivity`.

        The tier goes with it because a member who is not the owner is served
        the team-tier stamp: a private line that moved their dot would tell
        them the exact time of a change the file, the tree and `list_changes`
        all refuse them. `next.entry.vis` is the entry's own flag, the one
        already written into the line.
      */
      try {
        store.reportActivity?.(next.entry.vis === "team");
      } catch {
        // A reporter that throws synchronously is still not a failed change.
      }
      return;
    }
  } catch {
    // See the header: a change is never failed by its own footnote.
  }
}
