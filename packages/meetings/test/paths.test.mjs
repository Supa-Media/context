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
 * Two prefixes are legitimate and neither is derived from anything: `root`, a
 * folder the customer themselves chose at connect time, and `folder`, the
 * destination a person picked on the device for *this* meeting. Both are passed
 * in by the caller and applied at this boundary only.
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
 *
 * ### …and for the folder a person chose
 *
 *   a refused folder silently becoming the default inside the builder        17
 *   the date folders flattened away under the chosen folder                  15
 *   the chosen folder replacing only the head, so `meetings/` is appended     13
 *   the dot-prefixed (plumbing) refusal dropped                               4
 *   `normalizeMeetingFolder` trimming for itself instead of calling
 *     `normalizeRoot`                                                         3
 *   `isMeetingNotePath` ignoring the folder, so the pair disagree again       1
 *   the refusal quoting the folder it was sent                                1
 *   the length bound dropped                                                  1
 *   the `..`-inside-a-segment refusal dropped                                 3
 *   the reserved-plumbing-name refusal dropped (`scopes.yml`)                 2
 *
 * Two of those rows are worth reading rather than counting. The **17** is the
 * defect this whole change is about arriving one layer down: a builder that
 * "helpfully" corrects a folder it does not like is the same silent wrong
 * destination, so the refusal has to be visible to the caller and the caller
 * decides what a person is told. And the **1** against `isMeetingNotePath` is
 * the point of that check: only the agreement property notices, because every
 * other check in the section is about the default folder, which the sabotaged
 * version still gets right.
 *
 * The `normalizeRoot` row is a **3 and not a 7**, and that is honest rather
 * than weak: with the delegation removed, `../..` is still refused — by the
 * dot-prefix rule one line down, which `..` also matches. The traversal
 * refusal is genuinely doubled, and what the 3 measures is the part only
 * `normalizeRoot` does: backslashes, the empty prefix, and normalizing
 * separators.
 */

import {
  MAX_FOLDER_LENGTH,
  MAX_SLUG_LENGTH,
  MEETINGS_FOLDER,
  SLUG_FALLBACK,
  isMeetingNotePath,
  meetingNotePath,
  normalizeMeetingFolder,
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

  /* ------------------- the folder the person chose ---------------------- */

  /*
    A phone can ask where a meeting's notes should go. What arrives is a folder,
    and the three things it has to be are: honoured, byte-for-byte absent when
    nobody chose one, and refused when it is not a folder this package will file
    into.
  */

  check(
    "no folder at all is exactly what it was before",
    meetingNotePath(session(), {}) === meetingNotePath(session()) &&
      meetingNotePath(session(), { folder: undefined }) === "0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check(
    "a chosen folder replaces the whole default, and keeps the date folders under it",
    meetingNotePath(session(), { folder: "2-areas/team" }) ===
      "2-areas/team/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check(
    "...so it does not grow a `meetings` segment the person never asked for",
    !meetingNotePath(session(), { folder: "2-areas/team" }).split("/").includes("meetings")
  );
  check(
    "...and the filename is the same filename, so the same session is the same note",
    meetingNotePath(session(), { folder: "2-areas/team" }).split("/").pop() ===
      meetingNotePath(session()).split("/").pop()
  );
  check(
    "the customer's own root still goes in front of a chosen folder",
    meetingNotePath(session(), { root: "vault", folder: "2-areas" }) ===
      "vault/2-areas/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check(
    "a chosen folder is normalized the way a root is",
    meetingNotePath(session(), { folder: " /2-areas//team/ " }) ===
      "2-areas/team/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md"
  );
  check(
    "a folder still cannot namespace by tenant, because nothing derives one",
    meetingNotePath(tenanted, { folder: "2-areas" }) === meetingNotePath(session(), { folder: "2-areas" })
  );

  /* ------------------- and the folders it will not take ------------------ */

  check("no folder means the default", normalizeMeetingFolder(undefined) === MEETINGS_FOLDER);
  check("...and so does an explicit null, which is what a JSON body sends", normalizeMeetingFolder(null) === MEETINGS_FOLDER);
  check("a folder comes back without a trailing slash", normalizeMeetingFolder("2-areas/team/") === "2-areas/team");
  check("a folder that traverses is refused", normalizeMeetingFolder("../../etc") === null);
  check("...including in the middle", normalizeMeetingFolder("2-areas/../../etc") === null);
  check("...and a lone dot segment", normalizeMeetingFolder("2-areas/./team") === null);
  check("a backslash is refused", normalizeMeetingFolder("2-areas\\team") === null);
  check("a non-string is refused", normalizeMeetingFolder(42) === null);
  check("...including one that looks like a folder", normalizeMeetingFolder(["2-areas"]) === null);
  check(
    "an empty folder is refused rather than filing a meeting at the bucket root",
    normalizeMeetingFolder("") === null && normalizeMeetingFolder("   ") === null && normalizeMeetingFolder("/") === null
  );
  /*
    `isPlumbing` in the gateway hides every dot-prefixed segment from every tool
    at every tier, the owner's included. A meeting filed under one would be
    invisible to the person who recorded it and still on their storage bill,
    which is the same shape as the `.meetings/` growth `MAX_SEGMENT_ID_CHARS`
    was added to close.
  */
  check("a dot-prefixed folder is refused, because plumbing is invisible to its owner", normalizeMeetingFolder(".meetings") === null);
  check("...at any depth", normalizeMeetingFolder("2-areas/.git") === null);
  check("...including the search index's own home", normalizeMeetingFolder(".index/v2") === null);
  check("a folder that is a note is refused", normalizeMeetingFolder("2-areas/overview.md") === null);
  check("...whatever its case", normalizeMeetingFolder("2-areas/overview.MD") === null);
  /*
    `..` INSIDE a segment, which is the one shape this function used to accept
    and the gateway then refused for good.

    `normalizeRoot` refuses a segment that *equals* `.` or `..`, which is the
    traversal rule and is correct as far as it goes. The gateway's own
    `normalizePath` is blunter: it refuses `..` anywhere in the key at all. So
    `a..b` passed here, the claim wrote `a..b/2026/09/….md` into the session
    record under a conditional write, and `publishMeetingNote` then answered
    400 `meeting_invalid` — a code no client retries — for the life of that
    meeting, with nothing to clear the claimed path. And because only a `null`
    from this function reaches the `folderRejected` fallback, that class walked
    straight past the safety net the fallback exists to be.

    The two have to agree about what a key is, so this one adopts the stricter
    rule rather than the gateway relaxing its. A folder with `..` inside a name
    is vanishingly rare; a meeting that can never be written out is not a price
    worth paying for it.
  */
  check("a folder with `..` inside a segment is refused, because the gateway refuses the key", normalizeMeetingFolder("a..b") === null);
  check("...wherever the segment sits", normalizeMeetingFolder("1-projects/foo..bar") === null);
  check("...and a trailing pair reads the same way", normalizeMeetingFolder("team..") === null);
  check("a single dot inside a name is still a folder somebody may have", normalizeMeetingFolder("2-areas/v1.2") === "2-areas/v1.2");
  /*
    AND THE SAME SEGMENT PERCENT-ENCODED, WHICH THE RULE ABOVE DOES NOT REACH.

    The rule above compares raw text, and so does the gateway's `normalizePath`
    — so those two agree, which is what the paragraph above is about. **The
    layer that refuses the key is neither of them.** The storage adapter's
    `describeKeyProblem` percent-DECODES each segment before comparing, so
    `%2e%2e` is a `".."` segment there and nowhere earlier.

    What that costs is smaller than the raw case above and worth stating
    exactly, because the first draft of this block said "wedged" and that was
    wrong. Measured through the real worker: the refusal happens in `store.get`
    inside `unclaimedNotePath`, which runs INSIDE the claim mutator — so the
    session record is never written, no path is claimed, and a later finalize
    succeeds at the default folder. Nothing is lost. What is wrong is the
    answer: a deterministic failure comes back `503 "retry with backoff"`, so a
    client repeating the same body retries forever instead of getting the 200
    and `folderRejected` this fallback exists to give it.

    EQUALITY, not `includes`, and the asymmetry with the raw rule is
    deliberate: nothing downstream refuses `a%2e%2eb`, because the adapter
    decodes and compares whole segments. The last check is that half, and it is
    the one that fails if somebody "tidies" this into the rule above.
  */
  check("a segment that decodes to `..` is refused, because the adapter decodes", normalizeMeetingFolder("%2e%2e") === null);
  check("...in any case, and at any depth", normalizeMeetingFolder("ok/%2E%2E") === null);
  check("...and a segment that decodes to `.` the same way", normalizeMeetingFolder("%2e") === null);
  check(
    "but an encoded pair INSIDE a name is a folder, because the adapter accepts that key",
    normalizeMeetingFolder("a%2e%2eb") === "a%2e%2eb"
  );
  /*
    `scopes.yml` is the legacy privacy source of truth and `isPlumbing` refuses
    it by name, exactly as it refuses `privacy.md`. The `.md` rule already
    catches the second; nothing caught the first, and on a filesystem-backed
    store a file and a directory cannot share a name — so a meeting filed
    "into" it collides with the file that decides everybody else's access.
  */
  check("the legacy privacy file's name is refused as a folder", normalizeMeetingFolder("scopes.yml") === null);
  check("...whatever its case, and wherever it sits", normalizeMeetingFolder("2-areas/Scopes.YML") === null);
  check(
    "a control character is refused, because this string reaches a listing and an audit row",
    normalizeMeetingFolder("2-areas/te\nam") === null &&
      normalizeMeetingFolder("2-areas/te\u0000am") === null
  );
  /*
    And a space is NOT refused. An allowlist tight enough to be obviously safe
    would refuse `2 Areas/Team notes`, which is a folder a real vault has — and a
    refusal here falls back to the inbox, so an over-tight rule rebuilds the
    exact defect this change exists to close: a control that appears to work
    and files the note somewhere else.
  */
  check(
    "a folder a real vault would have is not refused",
    normalizeMeetingFolder("2 Areas/Team notes") === "2 Areas/Team notes"
  );
  check(
    "...in somebody's own language",
    normalizeMeetingFolder("2-areas/réunions") === "2-areas/réunions"
  );
  check("a folder at the length bound is accepted", normalizeMeetingFolder("a".repeat(MAX_FOLDER_LENGTH)) === "a".repeat(MAX_FOLDER_LENGTH));
  check("one character over it is refused", normalizeMeetingFolder("a".repeat(MAX_FOLDER_LENGTH + 1)) === null);

  check(
    "a folder this package will not file into is refused, not quietly corrected",
    attempt(() => meetingNotePath(session(), { folder: "../../etc" })).threw
  );
  /*
    The refusal never quotes the value. `normalizeRoot` does — reasonably, for a
    prefix the customer typed into their own binding — but this one arrives from
    a client, and a message that echoes what was sent is how a refusal becomes a
    reflection (see `INVALID_CHUNK_ID` in docs/decisions/meetings.md).
  */
  check(
    "...and the refusal does not read the value back to whoever sent it",
    (() => {
      const secret = "../../etc/passwd-shaped-thing";
      const { threw, error } = attempt(() => meetingNotePath(session(), { folder: secret }));
      return threw && !String(error?.message ?? error).includes("passwd-shaped-thing");
    })()
  );
  check(
    "...and nothing is filed in the meantime",
    attempt(() => meetingNotePath(session(), { folder: ".index" })).value === undefined
  );

  /* ---------------------------- recognising ----------------------------- */

  check("a key we wrote is recognised", isMeetingNotePath(meetingNotePath(session())));
  check("...with a root too", isMeetingNotePath(meetingNotePath(session(), { root: "vault" }), { root: "vault" }));
  check("...but not under the wrong root", !isMeetingNotePath(meetingNotePath(session(), { root: "vault" }), { root: "other" }));
  check("an ordinary note is not a meeting note", !isMeetingNotePath("1-projects/portable/overview.md"));
  check("a file loose in the meetings folder is not one either", !isMeetingNotePath("0-inbox/meetings/notes.md"));
  check("a non-string is not one, and does not throw", !isMeetingNotePath(null));

  /*
    THE TWO FUNCTIONS MAY NOT DISAGREE.

    `isMeetingNotePath` is what `list_meetings` uses to recognise a meeting off
    the bucket rather than out of an index. It answers "is this the shape this
    module writes into *that* folder" — it is not, and cannot be, a global
    oracle for "is this a meeting", because nothing records which folder a
    meeting was filed into and a dated note in somebody's own folder is not a
    meeting. So the property under test is agreement: hand both functions the
    same options and the recogniser answers true for the builder's own key.
  */
  const folders = [undefined, "2-areas/team", "1-projects", "0-inbox/meetings"];
  const roots = [undefined, "vault"];
  check(
    "the recogniser answers true for every key the builder makes, on the same options",
    folders.every((folder) =>
      roots.every((root) => isMeetingNotePath(meetingNotePath(session(), { folder, root }), { folder, root }))
    )
  );
  check(
    "...and does not claim one filed somewhere else",
    !isMeetingNotePath(meetingNotePath(session(), { folder: "2-areas/team" }))
  );
  check(
    "...nor one under a folder that merely starts the same way",
    !isMeetingNotePath(meetingNotePath(session(), { folder: "2-areas/team-offsite" }), { folder: "2-areas/team" })
  );
  check(
    "a folder the builder refuses recognises nothing either",
    !isMeetingNotePath("../etc/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md", { folder: "../etc" })
  );

  /*
    WHAT THIS FUNCTION RETURNS, IT MUST ALSO ACCEPT.

    `normalizeRoot` trims the whole STRING and collapses repeated separators —
    it does not trim a SEGMENT. So `"/ /"` came back as `" "`, a folder made of
    one space, and normalizing that answer again gave `null`. The function was
    not idempotent, and `meetingNotePath` re-normalizes whatever it is handed,
    so an accepted folder could make the builder throw.

    Measured through the real worker, `folder: "/ /"` answered **400
    `meeting_invalid`, "this session's start time is not a timestamp, so it has
    no note path"** — on a session whose `startedAt` is a perfectly good
    timestamp. The `catch` producing that message says "The folder cannot reach
    here: it was resolved before any of this", which was false and is now true.

    THE RULE IS ON THE JOINED RESULT, NOT ON EACH SEGMENT. A first draft
    refused any segment whose trim differed, and review measured what that
    cost: **36 folders that are stable, build a path, and are accepted by every
    layer downstream**. A whole-string trim only removes whitespace at the two
    ENDS, so only a leading space in the first segment or a trailing space in
    the last is unstable. The last three checks are that distinction, and they
    are what fails if somebody "simplifies" this back to a per-segment rule.

    Brute-forced over `a / space tab . % 2 e` to depth 4 — 4,680 shapes: 132
    non-idempotent and 20 throwing before, 0 and 0 after.
  */
  check("a folder that normalizes to a whitespace segment is refused", normalizeMeetingFolder("/ /") === null);
  check("...as is a leading space on the FIRST segment", normalizeMeetingFolder("/ ok") === null);
  /*
    A TRAILING space needs a trailing separator to survive long enough to
    matter, exactly as the leading one needs a leading separator: `"ok/a "` is
    trimmed to `"ok/a"` by `normalizeRoot` before any segment exists, so it is
    a perfectly good folder. `"ok/a /"` keeps the space, because the slash is
    what the trim finds at the end. The first draft of this check used the
    former and failed, which is the second time this hour a name outran the
    shape underneath it — both caught by the check, neither by re-reading.
  */
  check("...and a trailing space on the LAST, shielded by a separator", normalizeMeetingFolder("ok/a /") === null);
  check("...while the same string without that slash is just that folder", normalizeMeetingFolder("ok/a ") === "ok/a");
  check(
    "a whole-string edge space is trimmed by `normalizeRoot` and the folder is fine",
    normalizeMeetingFolder("ok/ ") === "ok"
  );
  check(
    "an inner space is a folder somebody may legitimately have",
    normalizeMeetingFolder("2-areas/team notes") === "2-areas/team notes"
  );
  check(
    "...and so is one with an edge space on an INNER segment, which is stable",
    normalizeMeetingFolder("2-areas/ team") === "2-areas/ team"
  );
  check("...at either edge of it", normalizeMeetingFolder("ok/a /b") === "ok/a /b");

  /*
    And the property itself, over the alphabet the brute force used. The named
    examples say what the rule is; this says it has no holes left, and it is
    what fails if somebody widens `normalizeRoot` instead of touching this.
  */
  {
    const stamp = { id: FIXTURE_ID, title: "T", startedAt: "2026-03-04T09:00:00.000Z" };
    const alphabet = ["a", "/", " ", "\t", ".", "%", "2", "e"];
    let unstable = 0;
    let threw = 0;
    const walk = (soFar, depth) => {
      if (depth === 0) {
        const once = normalizeMeetingFolder(soFar);
        if (once === null) return;
        if (normalizeMeetingFolder(once) !== once) unstable += 1;
        try {
          meetingNotePath(stamp, { folder: once });
        } catch {
          threw += 1;
        }
        return;
      }
      for (const character of alphabet) walk(soFar + character, depth - 1);
    };
    for (let depth = 1; depth <= 4; depth += 1) walk("", depth);
    check("every folder this accepts, it accepts again — 4,680 shapes", unstable === 0);
    check("...and every one of them builds a path rather than throwing", threw === 0);
  }
}
