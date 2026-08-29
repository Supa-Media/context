/**
 * Orientation: the budgeted walk, and the handshake that must not depend on it.
 *
 * `orient` is the first thing a connected agent calls and the only thing that
 * tells it what is in here, so it has two failure modes that matter and neither
 * is a privacy bug (those live in `test.mjs`, against the shared fixture):
 *
 * 1. **It lies about size.** The walk is bounded — it runs against a bucket we
 *    do not own, on the customer's request quota — so a context bigger than the
 *    budget must report a floor. A precise-looking number that is not the truth
 *    is the bug this repository has already shipped twice.
 * 2. **It takes the connection down with it.** The connect-time instructions
 *    now carry a live sketch of the context, which means a slow bucket, a
 *    revoked key, or a `privacy.md` somebody broke in Obsidian is suddenly on
 *    the path of the handshake. It must degrade to the static text, never fail.
 *
 * The shared suite's in-memory bucket returns every key in one page and ignores
 * `delimiter`, which is fine for privacy semantics and useless for both of the
 * above. This file therefore stands up its own bucket that paginates honestly
 * and collapses delimited prefixes the way R2 does.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`listBoundedKeys` given no page cap** (walk everything, never truncate).
 *    2 checks failed: the floor markers on the folder line and on its children.
 *    The *total* stayed honest, because a second folder here cannot be walked
 *    at all — which is why the floor has two independent causes and both are
 *    asserted.
 * 2. **The per-folder `try` widened to one outer `try`**, as it was in the
 *    first draft of the note census. 9 checks failed: one folder with a
 *    backslash in its name emptied the entire survey.
 * 3. **`instructionsForSession` allowed to throw** (the `catch` removed). 2
 *    checks failed — but only after the handshake check was tightened from
 *    "HTTP 200" to "carries a result". A thrown handler is answered with a
 *    JSON-RPC error over HTTP 200, so the first version of that check called a
 *    client that could not connect a successful connection.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

const OWNER_TOKEN = `cat_orientation_owner_${"0".repeat(14)}`;
const TEAM_TOKEN = `cat_orientation_member_${"0".repeat(13)}`;
const BROKEN_TOKEN = `cat_orientation_broken_${"0".repeat(13)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
  "  2-areas/vault: private\n  3-resources: team\n\n" +
  "note_overrides:\n  3-resources/refs/draft.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does.
 *
 * `limit` is spent on keys examined rather than rows returned — a collapsed
 * prefix costs a key, same as R2 — because a stub that pages more generously
 * than the real backend would let a budget bug through.
 */
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

/** A bucket that is bound, reachable in the control plane, and answers nothing. */
function createDeadBucket() {
  const fail = async () => {
    throw new Error("storage backend is unreachable");
  };
  return { get: fail, put: fail, delete: fail, list: fail };
}

async function rpc(env, token, method, params) {
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    { waitUntil() {} }
  );
  return { status: response.status, body: await response.json() };
}

async function orientText(env, token) {
  const { body } = await rpc(env, token, "tools/call", { name: "orient", arguments: {} });
  return body?.result?.content?.[0]?.text || "";
}

export async function runOrientationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const dead = createDeadBucket();

    for (const [workspace, slug, binding] of [
      ["ws_large", "large", "LARGE_BUCKET"],
      ["ws_dead", "dead", "DEAD_BUCKET"],
    ]) {
      controlPlane.addWorkspace(workspace, slug, {
        provider: "r2-binding",
        bindingName: binding,
        capabilities: { conditionalWrite: true },
        status: "active",
      });
    }
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_large",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_orientation_owner",
      userId: "user_orientation_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_large",
      role: "editor",
      scopes: ["context:read"],
      clientId: "mcp_client_orientation_member",
      userId: "user_orientation_member",
    });
    await controlPlane.addGrant({
      accessToken: BROKEN_TOKEN,
      workspaceId: "ws_dead",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_orientation_broken",
      userId: "user_orientation_broken",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "LARGE_BUCKET,DEAD_BUCKET",
      LARGE_BUCKET: bucket,
      DEAD_BUCKET: dead,
    };

    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# The front page\n\nShipping the gateway.");
    // Older than everything else, so a recency list that ignores timestamps and
    // falls back to key order would put it first and be caught.
    bucket.seed("2-areas/vault/old-secret.md", "private", new Date("2020-01-01T00:00:00Z"));
    bucket.seed("2-areas/handbook.md", "team reference", new Date("2024-06-01T00:00:00Z"));
    bucket.seed(
      "1-projects/gateway/decision.md",
      "the decision",
      new Date(Date.now() - 3 * 60 * 60 * 1000)
    );
    // One folder past the walk budget: five pages of a thousand keys.
    for (let index = 0; index < 5_001; index += 1) {
      bucket.seed(
        `1-projects/bulk/note-${String(index).padStart(5, "0")}.md`,
        "bulk",
        new Date("2023-01-01T00:00:00Z")
      );
    }
    // A team-readable folder whose only note is privately overridden: visible
    // as a place, empty of anything a colleague may read.
    bucket.seed("3-resources/refs/draft.md", "not for the team", new Date("2024-01-01T00:00:00Z"));
    // A folder name the storage adapter refuses outright. Seeded straight into
    // the backing map, because `assertSafeKey` is exactly what stops it being
    // written through the adapter — and rclone or Obsidian are under no such
    // obligation.
    bucket.seed("1-projects\\legacy/note.md", "written by something else");

    const owner = await orientText(env, OWNER_TOKEN);

    check(
      "orient reports a folder past its budget as a floor",
      /^- 1-projects\/ — 5000\+ notes$/m.test(owner)
    );
    check(
      "a floor travels down to the child folders drawn from the same walk",
      /^ {2}- 1-projects\/bulk\/ — \d+\+$/m.test(owner)
    );
    check("orient's total is a floor when any folder was truncated", /^5\d{3}\+ notes visible/m.test(owner));
    check("orient explains the floor markers when it prints one", owner.includes("are floors"));
    check(
      "a folder the adapter refuses to list is named, not dropped",
      owner.includes("1-projects\\legacy/ — could not be listed")
    );
    check(
      "one unlistable folder does not suppress the rest of the survey",
      owner.includes("- 2-areas/ — 2 notes") && owner.includes("1-projects/gateway/")
    );
    // Asserted as presence *and* order. The first version of this compared two
    // `indexOf` results, and passed for the wrong reason the moment the newer
    // note stopped appearing at all: -1 sorts before everything.
    const recent = owner.split("## Recently updated")[1]?.split("---")[0] || "";
    check(
      "orient ranks recent activity by timestamp, not by key",
      recent.includes("2-areas/handbook.md — 2y ago") &&
        recent.indexOf("index.md — ") < recent.indexOf("2-areas/handbook.md —") &&
        recent.indexOf("2-areas/handbook.md —") < recent.indexOf("1-projects/bulk/")
    );
    check(
      "a sampled recency list says it is a sample",
      recent.includes("this call reached")
    );
    check("orient carries the customer's own front page", owner.includes("Shipping the gateway."));

    // A store that reports another page and then offers no continuation token.
    // `IsTruncated` and `NextContinuationToken` are read from independent tags
    // in `store/s3.js` with nothing checking they agree, so this pair is what a
    // slightly-wrong endpoint produces. `listBoundedKeys` computed its cursor as
    // `page.truncated ? page.cursor : undefined` and left `truncated` false, so
    // the walk stopped and orient printed a short count as an exact total —
    // "never a total" is the rule the whole survey is built on.
    const stalling = {
      ...bucket,
      list: async (options) => {
        const page = await bucket.list(options);
        // Only the flat per-folder walk, so the folder map itself is unaffected
        // and this probe changes exactly one thing.
        return !options?.delimiter && options?.prefix === "2-areas/"
          ? { ...page, truncated: true, cursor: undefined }
          : page;
      },
    };
    const stalled = await orientText({ ...env, LARGE_BUCKET: stalling }, OWNER_TOKEN);
    check(
      "a folder whose walk the store would not finish is a floor, not a total",
      /^- 2-areas\/ — \d+\+ notes$/m.test(stalled) && !/^- 2-areas\/ — \d+ notes$/m.test(stalled)
    );
    check(
      "and the total carries the same floor",
      /notes visible/.test(stalled) && /\d\+ notes visible/.test(stalled)
    );

    const member = await orientText(env, TEAM_TOKEN);
    check("a team connection is not shown a private folder's notes", !member.includes("old-secret"));
    check(
      "a team connection's folder count excludes the private subfolder",
      /^- 2-areas\/ — 1 note$/m.test(member)
    );
    // "0 notes" is a claim about the folder; all we know is that nothing in it
    // reached this connection. The folder is still named — it is somewhere a
    // colleague may file something — but it is named without a number.
    check(
      "a folder with nothing visible in it is named without a count",
      /^- 3-resources\/$/m.test(member) && !member.includes("3-resources/ — 0")
    );
    check("the owner sees the same folder counted", /^- 3-resources\/ — 1 note$/m.test(owner));

    // -- save_context takes its orders from index.md
    //
    // The destination used to be `4-archive/chat-history/`, hardcoded, which is
    // a folder a custom layout may never have made and a word ("archive") for
    // where things go to stop mattering. What the person wants done at the end
    // of a session is theirs to write, in the file they already own.
    const save = async (token, args) => {
      const { body } = await rpc(env, token, "tools/call", {
        name: "save_context",
        arguments: { platform: "claude", content: "## User\nhi\n\n## Assistant\nhello", ...args },
      });
      return body?.result?.content?.[0]?.text || "";
    };

    // No procedure yet, and this fixture's manifest declares no 4-archive: the
    // fallback must not invent one.
    const assumed = await save(OWNER_TOKEN, {});
    check(
      "with no procedure and no 4-archive, a session lands in the inbox",
      /^saved: 0-inbox\/sessions\/claude\//m.test(assumed)
    );
    check(
      "an assumed destination says it was assumed, and how to change it",
      assumed.includes("destination: assumed") && assumed.includes("## Save context")
    );

    bucket.seed(
      "index.md",
      "# The front page\n\nShipping the gateway.\n\n" +
        "## Save context\n\ndestination: 2-areas/sessions\n\n" +
        "Three bullets of what we decided. Only keep the transcript if I asked for it.\n\n" +
        "## Something else\n\nNot part of the procedure.\n"
    );

    const directed = await save(OWNER_TOKEN, {});
    check(
      "a destination in index.md decides where a session lands",
      /^saved: 2-areas\/sessions\/claude\//m.test(directed)
    );
    check(
      "a followed destination is reported as the user's, not assumed",
      directed.includes("from this context's own save procedure") &&
        !directed.includes("destination: assumed")
    );
    check(
      "the procedure's prose comes back with the confirmation",
      directed.includes("Three bullets of what we decided") &&
        !directed.includes("Not part of the procedure")
    );

    const oriented = await orientText(env, OWNER_TOKEN);
    check(
      "orient carries the save procedure so an agent knows it before it needs it",
      oriented.includes("## Before this session ends") &&
        oriented.includes("Three bullets of what we decided") &&
        oriented.includes("`2-areas/sessions/`")
    );
    check(
      "the user's own procedure comes before the generic contract",
      oriented.indexOf("## Before this session ends") < oriented.indexOf("## Working here")
    );

    // A path that does not survive normalization is a typo in a file the person
    // can see and fix. Writing their sessions somewhere adjacent to what they
    // asked for is the worst of the available outcomes, so it is refused and
    // the fallback stands.
    bucket.seed("index.md", "# Front\n\n## Save context\n\ndestination: ../../etc\n");
    const rejected = await save(OWNER_TOKEN, {});
    check(
      "a destination that is not a safe folder path is refused, not repaired",
      /^saved: 0-inbox\/sessions\/claude\//m.test(rejected) && rejected.includes("assumed")
    );
    bucket.seed("index.md", "# Front\n\n## Save context\n\ndestination: notes/one.md\n");
    check(
      "a destination naming a note rather than a folder is refused",
      /^saved: 0-inbox\/sessions\/claude\//m.test(await save(OWNER_TOKEN, {}))
    );

    // The rename must not cost anybody a session: a client holding the cached
    // tool list is still calling `archive_chat`, with `history` rather than
    // `content`.
    const { body: legacy } = await rpc(env, OWNER_TOKEN, "tools/call", {
      name: "archive_chat",
      arguments: { platform: "codex", history: "## User\nold client" },
    });
    check(
      "the previous tool name and argument still save a session",
      /^saved: /m.test(legacy?.result?.content?.[0]?.text || "")
    );

    bucket.seed("index.md", "# The front page\n\nShipping the gateway.");

    // -- archive_note on a layout that has no archive
    //
    // This fixture's manifest deliberately declares no `4-archive`, which makes
    // it the case the tool used to get wrong: it would invent the folder, in a
    // bucket its owner also sees in Obsidian, to satisfy a destination the
    // owner never chose — the same layout assumption save_context and the
    // connect instructions were purged of.
    const { body: archiveRefusal } = await rpc(env, OWNER_TOKEN, "tools/call", {
      name: "archive_note",
      arguments: { path: "2-areas/handbook.md" },
    });
    const refusalText = archiveRefusal?.result?.content?.[0]?.text || "";
    check(
      "archive_note refuses rather than inventing a 4-archive on a custom layout",
      archiveRefusal?.result?.isError === true && refusalText.includes("no 4-archive")
    );
    check(
      "the refusal points at move_note and the owner's own conventions",
      refusalText.includes("move_note") && refusalText.includes("conventions")
    );
    check(
      "and nothing was created or moved by the refusal",
      ![...bucket.objects.keys()].some((key) => key.startsWith("4-archive/")) &&
        bucket.objects.has("2-areas/handbook.md")
    );

    // -- the connect-time sketch, and the handshake it must never endanger
    const connect = async (token) => {
      const { status, body } = await rpc(env, token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      // `result`, not just a 200: a thrown handler is answered with a JSON-RPC
      // error object over HTTP 200, so a status check alone would call a
      // client that cannot connect a successful handshake.
      return { status, ok: Boolean(body?.result), instructions: body?.result?.instructions || "" };
    };

    const ownerConnect = await connect(OWNER_TOKEN);
    check(
      "initialize sketches the context so a client knows what is here before calling anything",
      ownerConnect.instructions.includes("WHAT IS IN HERE") &&
        ownerConnect.instructions.includes("Shipping the gateway.")
    );
    check(
      "the connect sketch names the top level",
      ownerConnect.instructions.includes("1-projects/") &&
        ownerConnect.instructions.includes("2-areas/")
    );
    check(
      "the connect sketch points at orient for the live answer",
      /snapshot taken when this connection opened/.test(ownerConnect.instructions)
    );

    // THE SKETCH IS FILTERED, AND ONLY AN OWNER CONNECTION HAD EVER PROVED IT.
    //
    // `instructionsForSession` runs its folder prefixes through `canSee` and
    // its root notes through `isVisibleNote`, and the function's own comment
    // says a team connection "is told exactly what a team connection may
    // know". Nothing checked it: `connect` was only ever called with the owner
    // and the broken token, so removing BOTH filters left all 615 checks
    // green while a colleague's system prompt gained the owner's private root
    // folders on every conversation — silently, before they had called
    // anything.
    //
    // This manifest is `default_visibility: private` with named team folders,
    // so the three below are private by three different routes: `0-inbox/` by
    // the default, `1-projects\legacy/` because a backslash is not a path
    // separator and it is therefore its own unlisted root, and `privacy.md`
    // because it is plumbing.
    const teamConnect = await connect(TEAM_TOKEN);
    check(
      "a team connection still gets a sketch",
      teamConnect.status === 200 &&
        teamConnect.ok &&
        teamConnect.instructions.includes("WHAT IS IN HERE")
    );
    check(
      "and it names the folders that connection may see",
      teamConnect.instructions.includes("1-projects/") &&
        teamConnect.instructions.includes("2-areas/") &&
        teamConnect.instructions.includes("3-resources/")
    );
    check(
      "but never one it may not — the sketch is `canSee`-filtered, not raw",
      !teamConnect.instructions.includes("0-inbox/") &&
        !teamConnect.instructions.includes("1-projects\\legacy/") &&
        !teamConnect.instructions.includes("privacy.md")
    );
    // The owner's own sketch is the control: these are absent above because
    // they are filtered, not because the bucket lacks them.
    check(
      "and the owner's sketch does carry them, so the filter is what removed them",
      ownerConnect.instructions.includes("0-inbox/") &&
        ownerConnect.instructions.includes("1-projects\\legacy/")
    );

    // ...AND THE FRONT PAGE IS THE THIRD FILTERED COMPONENT, WHICH NOTHING
    // REACHED EITHER.
    //
    // The sketch is not only a folder map and a root-note list: it embeds the
    // *body* of `index.md`, gated by its own `canSee` in `readFrontPage`. This
    // fixture's manifest declares `index.md: team`, so that gate never had to
    // hold here and deleting the line left all 621 checks green.
    //
    // `index.md: private` is an ordinary choice — the file is a named entry in
    // `folder_defaults` precisely so it can be made one — and it is the case
    // where the gate is the only thing standing between a colleague's system
    // prompt and the owner's front-page prose, on every conversation, before
    // they have called anything. That is a worse disclosure than the folder
    // names above: names versus what the person actually wrote.
    check(
      "a team front page is given to a team connection",
      teamConnect.instructions.includes("Shipping the gateway.")
    );
    bucket.seed("privacy.md", PRIVACY_MANIFEST.replace("index.md: team", "index.md: private"));
    const withheldFrontPage = await connect(TEAM_TOKEN);
    // `ok` is NOT the control here, and the first version of this check
    // believed it was. It is `Boolean(body.result)`, and the fail-soft path
    // returns `SERVER_INSTRUCTIONS` — a perfectly good result over 200 — so a
    // collapsed sketch satisfies `status && ok` and hands the absence over for
    // free. Narrowing the bail in `instructionsForSession` to
    // `if (!frontPage) return SERVER_INSTRUCTIONS` is a plausible-looking
    // simplification, costs a team connection its ENTIRE sketch on a private
    // front page, and passed all 626 checks.
    //
    // #88's "a team connection still gets a sketch" does not cover it either:
    // that runs against `teamConnect`, captured before the reseed, when
    // `index.md` is still team-visible — so under that sabotage it has a front
    // page, builds a sketch, and passes. The control has to be re-established
    // on the connection this check actually examines, and it has to be
    // content only a real sketch contains. `1-projects/` is the second half:
    // the sketch must be intact, not merely present, or "only the front page
    // was removed" is not what was proved.
    //
    // THE TRAILING SLASH IS LOAD-BEARING, and it is worth being exact about
    // which case it buys. `SERVER_INSTRUCTIONS` names the PARA folders in
    // prose — `0-inbox, 1-projects, 2-areas, …` — so the bare `1-projects`
    // appears on every connection ever made, the fallback included. Only the
    // folder map emits the slash.
    //
    // Total collapse is caught by `WHAT IS IN HERE` whichever way this is
    // spelled. What the slash buys is the *gutted* map — a sketch that is
    // present but has lost a folder. Measured, dropping only `1-projects/`
    // from the layout: with the slash this check fails, without it the check
    // passes and the conjunct is decoration.
    //
    // The margin is one character, and it has already been the other way
    // round: this text used to tell agents to file work under `1-projects/`,
    // with the slash — see the note at `src/index.js:169`. If that phrasing
    // returns, this conjunct silently degrades and nothing here will say so.
    check(
      "a private one is withheld, and only it — the rest of the sketch survives",
      withheldFrontPage.status === 200 &&
        withheldFrontPage.ok &&
        withheldFrontPage.instructions.includes("WHAT IS IN HERE") &&
        withheldFrontPage.instructions.includes("1-projects/") &&
        !withheldFrontPage.instructions.includes("Shipping the gateway.")
    );
    // The owner is the control, for the same reason as above: absent because
    // it was filtered, not because the sketch quietly stopped being built.
    check(
      "while the owner still receives their own, so the gate is what withheld it",
      (await connect(OWNER_TOKEN)).instructions.includes("Shipping the gateway.")
    );

    // The same file and the same gate, reached by a second tool.
    // `readSaveProcedure` has its own `canSee("index.md")`, and deleting it
    // also left 621 green.
    //
    // The obvious probe is `save_context`, and it is a vacuous one: the tool
    // is a write, TEAM_TOKEN holds a read-only grant, and the refusal arrives
    // from `callToolForSession` before the procedure is ever read. Written
    // that way this passed with the gate deleted — a check answering a
    // question nobody asked. `orient` is the path that actually reaches it
    // from a read-only connection, which is also the connection this matters
    // for: the procedure lands in a colleague's orientation unbidden.
    bucket.seed(
      "index.md",
      "# The front page\n\nShipping the gateway.\n\n" +
        "## Save context\n\ndestination: 2-areas/sessions\n\n" +
        "Only the decisions, and never the transcript.\n"
    );
    // Asserted on the heading `orient` renders rather than on the prose. The
    // prose is inside `index.md`, so a broken *front page* gate would leak the
    // same words and fail this check too — and a check that fails for its
    // neighbour's defect stops telling you which one broke. This heading is
    // produced by `readSaveProcedure` and nothing else.
    const teamOriented = await orientText(env, TEAM_TOKEN);
    check(
      "a private front page's save procedure is withheld from a team connection",
      // The positive half is not decoration either: an `orient` that failed
      // outright would satisfy the absence for free.
      teamOriented.includes("## Working here") &&
        !teamOriented.includes("## Before this session ends")
    );
    const ownerOriented = await orientText(env, OWNER_TOKEN);
    check(
      "while the owner's own procedure still reaches them, so the gate withheld it",
      ownerOriented.includes("## Before this session ends") &&
        ownerOriented.includes("Only the decisions, and never the transcript")
    );

    // Restored to the pristine constants — which for `privacy.md` is not quite
    // the state this block found: the `save_context` checks above drove the
    // gateway to rewrite it through `mutateManifest`, so as-found it carried a
    // reordered `folder_defaults` and an extra override. Nothing below depends
    // on either, and re-seeding the constant is what the broken-privacy block
    // beneath already does. Said plainly because "restored" would overstate
    // it: a check inserted here that depended on accumulated manifest state
    // would silently see the constant instead.
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# The front page\n\nShipping the gateway.");

    const deadConnect = await connect(BROKEN_TOKEN);
    check(
      "an unreachable bucket still completes the handshake",
      deadConnect.status === 200 && deadConnect.ok
    );
    check(
      "an unreachable bucket falls back to the static instructions",
      deadConnect.instructions.includes("PARA") &&
        !deadConnect.instructions.includes("WHAT IS IN HERE")
    );

    // A privacy manifest nobody can parse must fail closed everywhere, and the
    // handshake is now one of the places that reads it.
    bucket.seed("privacy.md", "# not a manifest at all\n");
    const brokenPrivacy = await connect(OWNER_TOKEN);
    check(
      "a broken privacy manifest costs the sketch, not the connection",
      brokenPrivacy.status === 200 &&
        brokenPrivacy.ok &&
        brokenPrivacy.instructions.includes("PARA") &&
        !brokenPrivacy.instructions.includes("WHAT IS IN HERE")
    );
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
  } finally {
    restore();
  }
}
