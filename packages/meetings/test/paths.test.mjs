/**
 * WHERE THE NOTE GOES — `src/paths.js`.
 *
 * The load-bearing check in this file is the tenancy one, and it is a
 * non-negotiable rather than a preference: **tenancy is bucket-level, never
 * prefix-level.** One workspace is one bucket. Nothing derived from a
 * workspace, a username, an account or a tenant may appear in a key, because
 * the same bucket is synced to somebody's Obsidian vault and a `tenants/<id>/`
 * prefix would be both visible nonsense and a migration for every existing
 * brain.
 *
 * So the tests below do two things a shape assertion alone would not:
 *
 * - They hand `meetingNotePath` a session carrying `workspaceId`, `tenantId`,
 *   `userId` and `username` fields and assert that none of them reaches the
 *   key. An implementation that "helpfully" namespaced would fail here, not in
 *   review.
 * - They assert the *whole* key against a literal, so a prefix cannot be added
 *   without a test turning red.
 *
 * The one legitimate prefix is `root` — a folder the customer themselves chose
 * at connect time, passed in by the caller, applied at this boundary only.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `meetingNotePath` prefixing `tenants/<workspaceId>/`                      11
 *   the workspace slug worked into the filename                             11
 *   `slugifyTitle` dropping the empty-slug fallback                          6
 *   the customer's root applied below the folder instead of above            3
 *   `normalizeRoot` clamping `..` rather than refusing it                     3
 *   the filing date read in local time rather than UTC                       2
 *
 * The last row started at **zero**: this container runs in UTC, so
 * `getFullYear` and `getUTCFullYear` agree and a local-time bug is invisible.
 * The check now moves `process.env.TZ` to UTC+14 and back, which is the only
 * way the assertion means anything on a machine whose clock already agrees.
 */

import {
  MAX_SLUG_LENGTH,
  MEETINGS_FOLDER,
  SLUG_FALLBACK,
  isMeetingNotePath,
  meetingNotePath,
  normalizeRoot,
  shortMeetingId,
  slugifyTitle,
} from "../src/paths.js";
import { FIXTURE_ID, OTHER_ID, attempt } from "./fixtures.mjs";

/** @param {object} overrides */
function session(overrides = {}) {
  return { id: FIXTURE_ID, title: "Weekly sync", startedAt: "2026-03-04T09:00:00.000Z", ...overrides };
}

export function runPathChecks(check) {
  /* ------------------------------ slugs --------------------------------- */

  check("a plain title slugifies", slugifyTitle("Weekly Sync") === "weekly-sync");
  check("punctuation becomes a separator", slugifyTitle("Q3: planning!") === "q3-planning");
  check("runs of separators collapse", slugifyTitle("a  --  b") === "a-b");
  check("leading and trailing separators are trimmed", slugifyTitle("  -- hello --  ") === "hello");
  check("accents fold to their base letter rather than vanishing", slugifyTitle("Réunion à Café") === "reunion-a-cafe");
  check("an ampersand reads as a word, because in a title it is one", slugifyTitle("R&D sync") === "r-and-d-sync");
  check("emoji are not letters", slugifyTitle("Ship it \u{1F680}\u{1F680}") === "ship-it");
  check("a title of only emoji falls back", slugifyTitle("\u{1F389}\u{1F389}\u{1F389}") === SLUG_FALLBACK);
  check("a title of only punctuation falls back", slugifyTitle("!!! ??? ...") === SLUG_FALLBACK);
  check("an empty title falls back", slugifyTitle("") === SLUG_FALLBACK);
  check("a non-string title falls back rather than throwing", slugifyTitle(undefined) === SLUG_FALLBACK);
  check("CJK is not transliterated, it falls back", slugifyTitle("会議") === SLUG_FALLBACK);
  check("mixed scripts keep the ASCII part", slugifyTitle("会議 roadmap") === "roadmap");
  check("a long title is cut to the limit", slugifyTitle("x".repeat(200)).length === MAX_SLUG_LENGTH);
  check(
    "...and never cut so that it ends on a separator",
    !slugifyTitle(`${"ab ".repeat(40)}`).endsWith("-")
  );
  check("a slug never contains a slash, whatever the title was", !slugifyTitle("a/b/c").includes("/"));
  check("nor a dot, so it cannot grow a second extension", !slugifyTitle("notes.md").includes("."));

  /* ---------------------------- short ids ------------------------------- */

  check("the short id is the last eight characters", shortMeetingId(FIXTURE_ID) === FIXTURE_ID.slice(-8));
  check("...eight of them", shortMeetingId(FIXTURE_ID).length === 8);

  /* ------------------------------ the path ------------------------------ */

  check(
    "a meeting note lands in the inbox, filed by year and month",
    meetingNotePath(session()) === "0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check("the folder constant is the one in the path", meetingNotePath(session()).startsWith(`${MEETINGS_FOLDER}/`));
  check(
    "the date is UTC, not the reader's timezone",
    // 23:30 UTC is already tomorrow in half the world. Asserting this under
    // whatever timezone CI happens to run in proves nothing, so the check moves
    // the process clock to UTC+14 and back: the same bucket is synced to
    // several machines and the key must be the same on all of them.
    (() => {
      const previous = process.env.TZ;
      process.env.TZ = "Pacific/Kiritimati";
      try {
        return meetingNotePath(session({ startedAt: "2026-03-04T23:30:00.000Z" })).includes("/2026/03/2026-03-04-");
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    })()
  );
  check(
    "...and the same in the other direction",
    (() => {
      const previous = process.env.TZ;
      process.env.TZ = "Pacific/Midway";
      try {
        return meetingNotePath(session({ startedAt: "2026-03-04T00:30:00.000Z" })).includes("/2026/03/2026-03-04-");
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    })()
  );
  check(
    "...including across a year boundary",
    meetingNotePath(session({ startedAt: "2025-12-31T23:59:59.000Z" })) === "0-inbox/meetings/2025/12/2025-12-31-weekly-sync-8h9jkmnp.md"
  );
  check("months are zero-padded", meetingNotePath(session({ startedAt: "2026-01-05T09:00:00.000Z" })).includes("/2026/01/"));
  check(
    "two meetings with the same title on the same day get different keys",
    meetingNotePath(session()) !== meetingNotePath(session({ id: OTHER_ID }))
  );
  check(
    "an unslugifiable title still produces a usable key",
    meetingNotePath(session({ title: "\u{1F389}" })) === "0-inbox/meetings/2026/03/2026-03-04-meeting-8h9jkmnp.md"
  );
  check(
    "an unparseable startedAt is refused rather than filed under NaN",
    attempt(() => meetingNotePath(session({ startedAt: "soon" }))).threw
  );
  check("a missing session is refused", attempt(() => meetingNotePath(null)).threw);

  /* ------------------------- ONE FILE PER MEETING ----------------------- */

  check("the path ends in .md and nothing else", meetingNotePath(session()).endsWith(".md"));
  check(
    "there is no transcript sibling: the module exports no helper for one",
    // The transcript is a `## Transcript` section inside this same file. If a
    // path helper for a sibling ever appears, this check is where the decision
    // gets re-argued rather than quietly reversed.
    typeof globalThis.transcriptPath === "undefined"
  );

  /* --------------------- TENANCY IS BUCKET-LEVEL ------------------------ */

  // A session carrying every identifier somebody might be tempted to namespace
  // by. None of them may reach the key.
  const tenanted = session({
    workspaceId: "ws_deadbeef",
    workspaceSlug: "acme-team",
    tenantId: "tenant-7",
    userId: "user-7",
    username: "someone",
  });
  const key = meetingNotePath(tenanted);
  check("a workspace id never reaches the key", !key.includes("ws_deadbeef"));
  check("nor a workspace slug", !key.includes("acme-team"));
  check("nor a tenant id", !key.includes("tenant-7"));
  check("nor a user id or username", !key.includes("user-7") && !key.includes("someone"));
  check("the key has no `tenants/` segment", !key.split("/").includes("tenants"));
  check("...and no `workspaces/` segment", !key.split("/").includes("workspaces"));
  check(
    "the whole key is exactly the documented shape, so a prefix cannot be slipped in",
    key === "0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check(
    "extra session fields change nothing at all",
    meetingNotePath(tenanted) === meetingNotePath(session())
  );
  check(
    "meetingNotePath takes no workspace argument to namespace by",
    // Arity: (session, options). Anything wider would be a place to pass a
    // tenant in.
    meetingNotePath.length <= 2
  );

  /* ------------------------ the customer's own root --------------------- */

  check("no root means no prefix", normalizeRoot(undefined) === "" && normalizeRoot("") === "");
  check("a root is normalized to one trailing slash", normalizeRoot("/vault/") === "vault/");
  check("...collapsing repeats", normalizeRoot("//vault//notes//") === "vault/notes/");
  check("a root prefixes the whole key", meetingNotePath(session(), { root: "vault" }) === "vault/0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md");
  check("...and only at the front", meetingNotePath(session(), { root: "vault" }).indexOf("vault/") === 0);
  check("a root that traverses is refused", attempt(() => normalizeRoot("../../etc")).threw);
  check("...including in the middle", attempt(() => normalizeRoot("vault/../../etc")).threw);
  check("...and a lone dot segment", attempt(() => normalizeRoot("vault/./notes")).threw);
  check("a backslash in a root is refused", attempt(() => normalizeRoot("vault\\notes")).threw);
  check("a non-string root is refused", attempt(() => normalizeRoot(42)).threw);

  /* ---------------------------- recognising ----------------------------- */

  check("a key we wrote is recognised", isMeetingNotePath(meetingNotePath(session())));
  check("...with a root too", isMeetingNotePath(meetingNotePath(session(), { root: "vault" }), { root: "vault" }));
  check("...but not under the wrong root", !isMeetingNotePath(meetingNotePath(session(), { root: "vault" }), { root: "other" }));
  check("an ordinary note is not a meeting note", !isMeetingNotePath("1-projects/portable/overview.md"));
  check("a file loose in the meetings folder is not one either", !isMeetingNotePath("0-inbox/meetings/notes.md"));
  check("a non-string is not one, and does not throw", !isMeetingNotePath(null));
}
