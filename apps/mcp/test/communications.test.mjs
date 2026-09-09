/**
 * `list_channel_days` and `read_channel_day`: two reads over notes that hold
 * other people's mail.
 *
 * A channel-day note is an ordinary note at an ordinary path, so the privacy
 * engine already decides it and nothing here may bypass that. What these two
 * tools add is a *listing built from paths* — the same construction
 * `list_meetings` uses, with no index — and a read that leaves the message
 * bodies behind unless they are asked for. Both of those have a failure mode
 * the rest of the suite would not see:
 *
 * 1. **A listing is a count, and a count is an oracle.** "3 days" printed to a
 *    connection that may read one of them says a mailbox exists and how busy it
 *    is, which is a fact about somebody's life rather than about a note.
 * 2. **A day is one file and a file is one audience.** Two mailboxes under one
 *    folder rule each get their own visibility — that is the whole reason a
 *    mailbox is a folder — so the fixture below has one of each and asks a
 *    team-tier connection about both.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured:
 *
 * Re-measured on review, after the checks below it grew; where a number moved,
 * it is the count that was measured rather than the one that was expected.
 *
 * 1. **`canSee` dropped from the `list_channel_days` filter** — 6 checks
 *    failed: the private mailbox appeared in the listing, in its count, in the
 *    account-filter answer, and the "nothing to see" answer stopped being
 *    given.
 * 2. **`canSee` dropped from `read_channel_day`** — 3 checks failed, and the
 *    refusal stopped being byte-identical to the one a missing path gets.
 * 3. **`read_channel_day` returns the whole file regardless of the argument** —
 *    4 checks failed: a stranger's message bodies came back uninvited, with
 *    nothing said about them.
 * 4. **The listing sorted on the key instead of the parsed date** — 1 check
 *    failed: every day of the mailbox whose folder sorts first came before
 *    every day of the other, whatever the dates said. This is the trap
 *    `list_meetings` hit from the other direction when its date folders went.
 * 5. **The account filter removed** — 2 checks failed.
 * 6. **The account filter applied before `canSee` instead of after** — **0**
 *    checks failed, and that is written down rather than dropped: the two are
 *    ANDed, so the order cannot change the answer. `canSee` is what holds this,
 *    not where it sits, and sabotage 1 is the one that moves it.
 * 7. **The gateway keeping its own channel-day regex instead of the
 *    package's** — 7 checks failed, which is the number that says the two were
 *    never the same rule. `orient` called nine of fourteen keys automated mail
 *    capture that `list_channel_days` refuses to list.
 * 8. **`isMailboxSlug` dropped from `parseChannelDayPath`** — 1 check failed,
 *    and only after a check was added: the first run said 0, because a
 *    forwarded capture is *also* refused by the "email has an account level"
 *    rule one line above, so the fixture could not tell the two guards apart.
 *    A folder somebody made by hand in Obsidian (`0-inbox/email/Work_Box/`)
 *    is the case only this guard refuses, and it is now seeded.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { isChannelDayNotePath as recogniseInPackage } from "../../../packages/communications/src/paths.js";
import { classifyCaptureKind, isChannelDayNotePath as recogniseInGateway } from "../src/communications/paths.js";

const OWNER_TOKEN = `cat_comms_owner_${"0".repeat(20)}`;
const TEAM_TOKEN = `cat_comms_member_${"0".repeat(19)}`;

/**
 * One mailbox published to the team, one left private, and the folder default
 * that makes that a two-line change rather than a daily one.
 */
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  0-inbox/email/work-at-example-com: team\n\n" +
  "note_overrides:\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: stored.body.length, uploaded: stored.uploaded });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
}

async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

/** A day, rendered by the package that owns the format rather than by hand. */
function seedDay(bucket, { account, address, date, subjects, channel = "email", space }) {
  const events = subjects.map((subject, index) => ({
    channel,
    account,
    messageId: `<${date}-${index}@mail.example.net>`,
    threadId: `thread-${index}`,
    sentAt: `${date}T09:${String(index).padStart(2, "0")}:00.000Z`,
    subject,
    from: { name: `Sender ${index}`, address: `sender${index}@example.net` },
    body: `BODY-MARKER-${subject.replace(/\W+/g, "-")}`,
    ...(space ? { space } : {}),
  }));
  const text = renderChannelDayNote({
    channel,
    account,
    address,
    date,
    events,
    nonce: "0123456789abcdef",
    now: `${date}T20:00:00.000Z`,
  });
  const key =
    channel === "email"
      ? `0-inbox/email/${account}/${date}.md`
      : `0-inbox/${channel}/${date}.md`;
  bucket.seed(key, text);
  return key;
}

export async function runCommunicationsChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const sharedBucket = createBucket();
    controlPlane.addWorkspace("ws_comms", "comms", {
      provider: "r2-binding",
      bindingName: "COMMS_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    controlPlane.addWorkspace(
      "ws_comms_shared",
      "comms-shared",
      {
        provider: "r2-binding",
        bindingName: "SHARED_COMMS_BUCKET",
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      },
      { kind: "shared" }
    );
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_comms",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_comms_owner",
      userId: "user_comms_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_comms",
      role: "editor",
      scopes: ["context:read"],
      clientId: "mcp_client_comms_member",
      userId: "user_comms_member",
    });
    await controlPlane.addGrant({
      accessToken: "cat_test_shared_comms_owner_00000000",
      workspaceId: "ws_comms_shared",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_comms_shared_owner",
      userId: "user_comms_shared_owner",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "COMMS_BUCKET,SHARED_COMMS_BUCKET",
      COMMS_BUCKET: bucket,
      SHARED_COMMS_BUCKET: sharedBucket,
    };

    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# The front page");
    sharedBucket.seed("privacy.md", PRIVACY_MANIFEST);
    sharedBucket.seed("index.md", "# Shared front page");

    const workDay = seedDay(bucket, {
      account: "work-at-example-com",
      address: "work@example.com",
      date: "2026-09-05",
      subjects: ["Quarterly numbers", "Re: Quarterly numbers"],
    });
    // Deliberately the LATER date in the mailbox whose folder name sorts
    // FIRST — so a listing that sorted on the key rather than on the parsed
    // date would put this day in the wrong place, which is sabotage 4.
    const privateDay = seedDay(bucket, {
      account: "personal-at-example-net",
      address: "personal@example.net",
      date: "2026-09-07",
      subjects: ["Dinner"],
    });
    const chatDay = seedDay(bucket, {
      account: "",
      address: "",
      channel: "imessage",
      date: "2026-09-06",
      subjects: ["On my way"],
    });
    // Google Chat: also a no-account channel, but one level deeper — space,
    // then thread, then message — so this end-to-end pass through the real
    // gateway tools (not packages/communications' own tests) is what proves
    // `read_channel_day` surfaces that grouping rather than only the
    // renderer producing it correctly in isolation.
    const googleChatDay = seedDay(bucket, {
      account: "",
      address: "",
      channel: "google-chat",
      date: "2026-09-06",
      subjects: ["Standup notes"],
      space: { key: "spaces/AAAA1111", displayName: "Engineering Team", type: "group_chat" },
    });
    // Two notes in the same folder that are NOT days: the forwarded captures
    // this project deliberately left where they are, and a meeting.
    bucket.seed("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md", "# A forwarded capture");
    bucket.seed("0-inbox/meetings/2026-09-05-sync-8h9jkmnp.md", "# A meeting");
    // A folder a person made in Obsidian, inside the mail folder, holding a
    // dated note. It is not a mailbox — nothing this product wrote could be
    // named that — and calling it one would list somebody's own filing as a
    // channel they never connected.
    bucket.seed("0-inbox/email/Work_Box/2026-09-08.md", "# My own notes on mail");

    /* --------------------- one recogniser, not two ------------------------ */
    //
    // `src/communications/paths.js` arrived (#303) with its own regexes and a
    // header saying they should move into `packages/communications` the day it
    // landed. This is that day, and the move was not tidiness: the two
    // disagreed on nine of the fourteen keys below, always with the regex the
    // looser one — and the disagreement was live in opposite directions.
    // `list_channel_days` refused to list `0-inbox/email/Work_Box/…` as a
    // mailbox day (right: nothing this product writes could be named that),
    // while `orient` collapsed it out of "Recently updated" as automated mail.
    // A note somebody filed by hand vanished from the front page whose whole
    // job is to say what they have been doing.
    //
    // Identity is asserted first, because two functions that agree on a corpus
    // today are still two functions.

    check(
      "the gateway's channel-day recogniser IS the package's, not a copy of it",
      recogniseInGateway === recogniseInPackage
    );
    for (const [key, expected, why] of [
      ["0-inbox/email/name-at-example-com/2026-09-07.md", true, "a mailbox day"],
      ["0-inbox/email/name-at-example-com/2026-09-07-part-2.md", true, "a part of one"],
      ["0-inbox/google-chat/2026-09-07.md", true, "a channel with no account level"],
      ["0-inbox/email/Work_Box/2026-09-08.md", false, "a folder somebody made by hand"],
      ["0-inbox/email/.hidden/2026-09-07.md", false, "a dot segment"],
      ["0-inbox/email/../2026-09-07.md", false, "a traversal"],
      ["0-inbox/email/x/2026-02-30.md", false, "a day that does not exist"],
      ["0-inbox/imessage/2026-09-07-part-1.md", false, "a part number never written"],
      ["0-inbox/imessage/2026-09-07-part-02.md", false, "...nor a padded one"],
      ["0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md", false, "a forwarded capture"],
      ["0-inbox/meetings/2026-09-05-sync-8h9jkmnp.md", false, "a meeting"],
    ]) {
      check(
        `orient and list_channel_days answer the same for ${why}`,
        recogniseInGateway(key) === expected &&
          (classifyCaptureKind(key) === "channel-day") === expected
      );
    }

    /*
      A calendar day is its own kind, never `channel-day` — it lives at
      `0-inbox/calendar/<date>.md` with no channel or account segment at all,
      the layout `docs/decisions/communications.md`'s "A calendar lands beside
      the mail, not inside it" settles. The two recognisers must never both
      claim the same path.
    */
    for (const [key, expected, why] of [
      ["0-inbox/calendar/2026-09-07.md", "calendar-day", "a calendar day"],
      ["0-inbox/calendar/Work_Box/2026-09-07.md", null, "a folder somebody made by hand under calendar/"],
      ["0-inbox/calendar/2026-02-30.md", null, "a day that does not exist"],
      ["0-inbox/email/name-at-example-com/2026-09-07.md", "channel-day", "a mailbox day, still its own kind"],
    ]) {
      check(`classifyCaptureKind answers ${why} as ${expected}`, classifyCaptureKind(key) === expected);
    }
    check(
      "a calendar day and a channel day never both claim the same path — the two recognisers are disjoint",
      !recogniseInGateway("0-inbox/calendar/2026-09-07.md") && classifyCaptureKind("0-inbox/calendar/2026-09-07.md") !== "channel-day"
    );
    // Sabotage, measured: deleted the `isCalendarDayNotePath` branch from
    // `classifyCaptureKind` — 1 check failed ("classifyCaptureKind answers a
    // calendar day as calendar-day"), and only one, because a calendar day
    // falling through to `null` still does not misclassify as `channel-day`
    // or anything else — it just stops collapsing, which is the failure this
    // suite exists to catch on its own, separately, in orientation.test.mjs.

    /* ----------------------------- the listing ---------------------------- */

    const ownerList = await callTool(env, OWNER_TOKEN, "list_channel_days", { limit: 25 });
    check("list_channel_days finds a mailbox day", ownerList.includes(workDay));
    check("...and a channel with no account level", ownerList.includes(chatDay));
    check("...with the address the folder is only a slug of", ownerList.includes("work@example.com"));
    check("...and how much is in it", ownerList.includes("2 messages"));
    check(
      "a forwarded capture in the same folder is not listed as a day",
      !ownerList.includes("9f2c1d7a4b6e8035ac91d2f4")
    );
    check("...and neither is a meeting", !ownerList.includes("2026-09-05-sync"));
    check(
      "a folder in the mail folder that this product did not name is not a mailbox",
      !ownerList.includes("Work_Box")
    );
    check(
      "days come back newest first, by date rather than by folder name",
      ownerList.indexOf(privateDay) < ownerList.indexOf(chatDay) &&
        ownerList.indexOf(chatDay) < ownerList.indexOf(workDay)
    );
    check(
      "a channel filter narrows to one channel",
      (await callTool(env, OWNER_TOKEN, "list_channel_days", { channel: "imessage" })).includes(chatDay) &&
        !(await callTool(env, OWNER_TOKEN, "list_channel_days", { channel: "imessage" })).includes(workDay)
    );
    check(
      "an account filter narrows to one mailbox",
      !(await callTool(env, OWNER_TOKEN, "list_channel_days", { account: "work-at-example-com" })).includes(
        privateDay
      )
    );
    check("a Google Chat day is listed alongside every other channel", ownerList.includes(googleChatDay));
    check(
      "...and a channel filter narrows to it specifically",
      (await callTool(env, OWNER_TOKEN, "list_channel_days", { channel: "google-chat" })).includes(googleChatDay) &&
        !(await callTool(env, OWNER_TOKEN, "list_channel_days", { channel: "google-chat" })).includes(chatDay)
    );
    check(
      "read_channel_day on a Chat day surfaces the space heading through the real gateway path, not only the renderer's own tests",
      (await callTool(env, OWNER_TOKEN, "read_channel_day", { path: googleChatDay, messages: true })).includes(
        "Space — Engineering Team"
      )
    );
    check(
      "a Google Chat day is private by default, the same as any other unnamed folder",
      !(await callTool(env, TEAM_TOKEN, "list_channel_days", { channel: "google-chat" })).includes(googleChatDay) &&
        (await callTool(env, TEAM_TOKEN, "read_channel_day", { path: googleChatDay })) ===
          (await callTool(env, TEAM_TOKEN, "read_channel_day", { path: "0-inbox/google-chat/1999-01-01.md" }))
    );
    const sharedCommsWrite = await callTool(env, "cat_test_shared_comms_owner_00000000", "write_note", {
      path: "0-inbox/imessage/2026-09-07.md",
      content: "# iMessage\n",
      visibility: "private",
    });
    check(
      "shared workspaces refuse automated personal communications even for their owner",
      sharedCommsWrite.includes("personal communications can only be synced to a personal brain") &&
        !sharedBucket.objects.has("0-inbox/imessage/2026-09-07.md")
    );
    check(
      "a channel nobody has is a caller error, not a silent empty answer",
      (await callTool(env, OWNER_TOKEN, "list_channel_days", { channel: "carrier-pigeon" })).includes(
        "channel must be one of"
      )
    );
    check(
      // Refused by the advertised schema now, before the tool runs: the
      // definition says `minimum: 1, maximum: 25`, and `src/toolArguments.js`
      // enforces what the definition claims rather than leaving it to the
      // handler to re-derive.
      "an out-of-range limit is refused",
      (await callTool(env, OWNER_TOKEN, "list_channel_days", { limit: 99 })).includes(
        'argument "limit" must be at most 25'
      )
    );

    /* ------------------------------- privacy ------------------------------ */
    //
    // The mailbox with a folder rule is team; the one without inherits
    // `default_visibility: private`. That is the decision *the mailbox is a
    // folder* exists for, asserted from the side that matters.

    const teamList = await callTool(env, TEAM_TOKEN, "list_channel_days", { limit: 25 });
    check("a team connection sees the mailbox its owner published", teamList.includes(workDay));
    check("and cannot learn the private one exists by listing", !teamList.includes(privateDay));
    check("...not even that its folder is there", !teamList.includes("personal-at-example-net"));
    check("...nor by its count", !teamList.includes("personal@example.net"));
    check(
      "a channel whose every day is private answers as if there were none",
      (await callTool(env, TEAM_TOKEN, "list_channel_days", { channel: "imessage" })) ===
        "(no communications recorded yet)"
    );

    const teamReadsPrivate = await callTool(env, TEAM_TOKEN, "read_channel_day", { path: privateDay });
    const teamReadsAbsent = await callTool(env, TEAM_TOKEN, "read_channel_day", {
      path: "0-inbox/email/personal-at-example-net/2026-01-01.md",
    });
    check("a private day is 'not found' to a team connection", teamReadsPrivate === "not found");
    check(
      "...byte-identical to a path that never existed, so neither is an oracle",
      teamReadsPrivate === teamReadsAbsent
    );
    check(
      "and asking for the bodies does not get round it",
      (await callTool(env, TEAM_TOKEN, "read_channel_day", { path: privateDay, messages: true })) ===
        "not found"
    );
    /*
      The account filter narrows a list `canSee` has already filtered, so
      naming the private mailbox and naming one that has never existed have to
      be one answer — otherwise the filter is a probe over a namespace the
      caller cannot list.

      Measured rather than assumed: swapping the two filters fails **0**
      checks, and that is the correct number. They are ANDed, so the order
      cannot change the answer, and it is `canSee` alone that holds this — not
      its position. The sabotage that does move it is sabotage 1 below. This
      pair asserts the *answer*, which is the thing an oracle would break.
    */
    check(
      "naming the private mailbox in the filter is the same answer as naming a made-up one",
      (await callTool(env, TEAM_TOKEN, "list_channel_days", { account: "personal-at-example-net" })) ===
        (await callTool(env, TEAM_TOKEN, "list_channel_days", { account: "no-such-mailbox-at-example-org" }))
    );
    check(
      "...and that answer is the one an empty bucket gives",
      (await callTool(env, TEAM_TOKEN, "list_channel_days", { account: "personal-at-example-net" })) ===
        "(no communications recorded yet)"
    );

    /* ------------------------------- routing ------------------------------ */
    //
    // Routing is decided in `callToolForSession` and nowhere else, and
    // `crossContext.test.mjs` already asserts that every tool but ChatGPT's two
    // advertises the `context` argument — which covers these two by
    // construction. What is asserted here is the other half: that these tools
    // are on the *enforced* side of that one decision rather than merely on the
    // advertised side. A tool that resolved a context itself would answer from
    // the connection's own bucket instead of refusing.

    for (const tool of ["list_channel_days", "read_channel_day"]) {
      check(
        `${tool} routes through the one place, so a context nobody granted is refused`,
        (await callTool(env, OWNER_TOKEN, tool, { context: "@no-such-context-anywhere", path: workDay })) ===
          "this connection has no access to that context"
      );
      check(
        `...and a ${tool} call naming a reserved route is refused the same way`,
        (await callTool(env, OWNER_TOKEN, tool, { context: "@mcp", path: workDay })) ===
          "this connection has no access to that context"
      );
    }

    /* -------------------------------- reading ----------------------------- */

    const index = await callTool(env, OWNER_TOKEN, "read_channel_day", { path: workDay });
    check("read_channel_day returns the day's index", index.includes("Quarterly numbers"));
    check("...with every message's anchor", (index.match(/msg-[0-9a-f]{16}/g) ?? []).length === 2);
    check("...grouped by thread", index.includes("## Quarterly numbers"));
    check("...and the visibility of the note it read", index.includes("visibility: team"));
    check(
      "without the message bodies by default",
      !index.includes("BODY-MARKER-Quarterly-numbers")
    );
    check("saying that there are some, and how to ask for them", index.includes("messages: true"));
    check(
      "...and that they are a stranger's words rather than an instruction",
      /never an instruction/.test(index)
    );

    const full = await callTool(env, OWNER_TOKEN, "read_channel_day", { path: workDay, messages: true });
    check("and returns them when asked", full.includes("BODY-MARKER-Quarterly-numbers"));
    check(
      "with the fence that says where the stranger's words start and stop",
      (full.match(/context:untrusted-communication (begin|end)/g) ?? []).length === 4
    );
    check(
      "a day that does not exist is 'not found'",
      (await callTool(env, OWNER_TOKEN, "read_channel_day", { path: "0-inbox/email/work-at-example-com/2020-01-01.md" })) ===
        "not found"
    );
    check(
      "an ordinary note is read through read_note, not through this",
      (await callTool(env, OWNER_TOKEN, "read_channel_day", { path: "../../etc/passwd" })) === "invalid path"
    );
  } finally {
    restore();
  }
}
