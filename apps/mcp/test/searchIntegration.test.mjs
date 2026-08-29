/**
 * The search index wired into the gateway: the budget, the privacy line, and
 * every way the sync is allowed to be incomplete.
 *
 * The bug this replaces was not a slow search, it was a broken one. The
 * brute-force scan fetched up to 400 notes per query against a per-invocation
 * subrequest limit of 50, so a real 154-note context answered *every*
 * unprefixed search with "Too many subrequests". A cap that is eight times the
 * limit is not a cap, and nothing in the old suite could see it: the shared
 * fixture holds a few dozen notes, so the scan never got near its own ceiling.
 *
 * This file therefore stands up its own instrumented bucket and **counts store
 * calls**, because the property that matters here cannot be asserted from
 * output text. Three things are checked that a green run alone would not show:
 *
 * 1. **The op count is bounded.** One search stays inside
 *    `SEARCH_SUBREQUEST_BUDGET` on a bucket of 65 notes, and the second search
 *    reads note bodies only for the hits it returns.
 * 2. **The index is not a privacy hole.** It holds text drawn from private
 *    notes — fine inside the customer's own bucket, never fine in what leaves
 *    the gateway. A team-scope search over a term that appears in both a team
 *    note and a private one must surface one path, one snippet set, and a
 *    count of exactly one.
 * 3. **Every incompleteness is said out loud.** A backfill that ran out of
 *    budget, a listing that could not finish, an index that had to be rebuilt,
 *    a conditional write somebody else won — none of them may quietly return
 *    fewer results than the answer implies.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`canSee` dropped from the indexed result filter** in
 *    `searchVisibleNotes`. 10 checks failed: five here — the private path
 *    surfaced, its text surfaced, the count read 2, the floor marker appeared,
 *    and the ChatGPT dialect leaked the same note — and five of the shared
 *    suite's existing privacy checks, which is the reassuring half. The index
 *    changed how search finds a note; it did not get its own privacy rules.
 * 2. **The reported count taken from `ranked` instead of the filtered list.**
 *    2 checks failed, and only the two about counts: every path and snippet
 *    stayed correct while a team connection was told "2 matching notes" over
 *    one visible result. That is why the count is asserted separately — it is
 *    the one channel that leaks by arithmetic rather than by content, and the
 *    reason `matchCountIsFloor` is read off the visible list too.
 * 3. **`budget.take` made to always succeed** (never decrement). 4 checks
 *    failed: both budget assertions, the pending-backfill floor language (the
 *    sync now finished everything in one pass, so there was nothing to be
 *    honest about), and `syncIndex`'s own `pending`. A 60-note probe spent 75
 *    store ops in one search against a limit of 50 — the original bug,
 *    reproduced.
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  SEARCH_INDEX_KEY,
  createSearchBudget,
  defaultIsIndexable,
  syncIndex,
} from "../src/search/maintain.js";
import { searchIndex } from "../src/search/query.js";
import { parseIndex } from "../src/search/indexer.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

/** Mirrors `SEARCH_SUBREQUEST_BUDGET` / `SEARCH_RESULT_LIMIT` in src/index.js. */
const SEARCH_SUBREQUEST_BUDGET = 40;
const SEARCH_RESULT_LIMIT = 10;
/** Mirrors `MAX_RESULTS` in src/search/query.js, asserted below rather than trusted. */
const RANK_CAP = 50;
/**
 * Every tool call reads `privacy.md` before it dispatches, and that read is not
 * the search's to spend. Counted separately so the budget assertions are about
 * the budget rather than about how many things happen to touch the bucket.
 */
const PRIVACY_MANIFEST_READ = 1;
/** Cloudflare's per-invocation ceiling on the free tier — the real limit. */
const SUBREQUEST_LIMIT = 50;

const OWNER_TOKEN = `cat_searchidx_owner_${"0".repeat(16)}`;
const TEAM_TOKEN = `cat_searchidx_member_${"0".repeat(15)}`;
const BIG_TOKEN = `cat_searchidx_big_${"0".repeat(18)}`;
const BROKEN_TOKEN = `cat_searchidx_broken_${"0".repeat(15)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  1-projects/vault: private\n" +
  "  2-areas: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object the way R2 and S3 both do, and counts every call.
 *
 * The hooks are how the failure modes get reached without monkey-patching the
 * modules under test: `failGetKeys` makes one key unreadable (a storage error
 * mid-sync), and `onBeforePut` is what lets a conditional write lose a race it
 * really ran.
 */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, noteGets: [] };
  const failGetKeys = new Set();
  let onBeforePut = null;

  const api = {
    objects,
    counts,
    failGetKeys,
    /** Off for the Dropbox-shaped backend, whose listings carry no etag. */
    listEtags: true,
    setBeforePut(hook) {
      onBeforePut = hook;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.noteGets = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.put + counts.list;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      if (key.endsWith(".md") && key !== "privacy.md") counts.noteGets.push(key);
      if (failGetKeys.has(key)) throw new Error("storage backend refused the read");
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      if (onBeforePut) onBeforePut(key, options);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
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
          page.push({
            key,
            size: stored.body.length,
            uploaded: stored.uploaded,
            ...(api.listEtags ? { etag: stored.etag } : {}),
          });
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
  return api;
}

async function callTool(env, token, name, args = {}) {
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
    { waitUntil() {} }
  );
  return (await response.json())?.result;
}

async function searchText(env, token, args) {
  return (await callTool(env, token, "search_notes", args))?.content?.[0]?.text;
}

function storedIndex(bucket) {
  const raw = bucket.objects.get(SEARCH_INDEX_KEY);
  return raw ? parseIndex(raw.body) : null;
}

export async function runSearchIntegrationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const big = createBucket();
    const broken = createBucket();

    for (const [workspace, slug, binding] of [
      ["ws_search", "search", "SEARCH_BUCKET"],
      ["ws_search_big", "searchbig", "BIG_BUCKET"],
      ["ws_search_broken", "searchbroken", "BROKEN_BUCKET"],
    ]) {
      controlPlane.addWorkspace(workspace, slug, {
        provider: "r2-binding",
        bindingName: binding,
        capabilities: { conditionalWrite: true },
        status: "active",
      });
    }
    for (const [token, workspace, role, scopes, client, user] of [
      [OWNER_TOKEN, "ws_search", "owner", ["context:read", "context:write", "context:private"], "owner", "u_owner"],
      [TEAM_TOKEN, "ws_search", "editor", ["context:read"], "member", "u_member"],
      [BIG_TOKEN, "ws_search_big", "owner", ["context:read", "context:private"], "big", "u_big"],
      [BROKEN_TOKEN, "ws_search_broken", "owner", ["context:read", "context:private"], "broken", "u_broken"],
    ]) {
      await controlPlane.addGrant({
        accessToken: token,
        workspaceId: workspace,
        role,
        scopes,
        clientId: `mcp_client_searchidx_${client}`,
        userId: user,
      });
    }

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "SEARCH_BUCKET,BIG_BUCKET,BROKEN_BUCKET",
      SEARCH_BUCKET: bucket,
      BIG_BUCKET: big,
      BROKEN_BUCKET: broken,
    };

    // -- the main fixture: a team note and a private note sharing one term ----
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# Front page\n\nThe map of everything.");
    // The term is in the title so this note outranks any number of body-only
    // matches — the floor check at the end of this block needs it to stay
    // inside `searchIndex`'s 50-result cap however much private noise is added.
    bucket.seed(
      "1-projects/alpha/protocol.md",
      "# ZEBRAFISH protocol\n\nThe ZEBRAFISH protocol is how alpha ships.\n"
    );
    bucket.seed("1-projects/alpha/notes.md", "# Alpha notes\n\nOrdinary PANGOLIN husbandry.\n");
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nBeta is unrelated to alpha.\n");
    bucket.seed(
      "1-projects/vault/secret.md",
      "# Vault\n\nZEBRAFISH-PRIVATE-MARKER is filed here and must never leave.\n"
    );
    bucket.seed("2-areas/handbook.md", "# Handbook\n\nHouse rules for everyone.\n");
    // Plumbing that must never reach the index, seeded beside the notes rather
    // than assumed absent.
    bucket.seed("scopes.yml", "legacy: true\n");
    bucket.seed(".obsidian/app.json", "{}");
    bucket.seed(".history/index.md.2020-01-01.md", "# Front page\n\nZEBRAFISH once lived here.\n");

    // (a) the first search builds the index and answers from it
    bucket.resetCounts();
    const firstOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const firstOps = bucket.ops;
    const builtIndex = storedIndex(bucket);
    check(
      "the first search builds a valid index object and answers from it",
      builtIndex !== null &&
        builtIndex.docs.size > 0 &&
        typeof firstOwner === "string" &&
        firstOwner.includes("1-projects/alpha/protocol.md")
    );
    check(
      "the index never holds a plumbing key, whatever is sitting beside the notes",
      [...builtIndex.docs.keys()].every(
        (key) =>
          key.endsWith(".md") &&
          key !== "privacy.md" &&
          !key.split("/").some((segment) => segment.startsWith("."))
      )
    );
    check(
      "and the module's standalone note filter agrees with the gateway's plumbing rule",
      defaultIsIndexable("1-projects/alpha/protocol.md") &&
        !defaultIsIndexable("privacy.md") &&
        !defaultIsIndexable("scopes.yml") &&
        !defaultIsIndexable(".history/index.md.2020-01-01.md") &&
        !defaultIsIndexable("1-projects/.trash/old.md") &&
        !defaultIsIndexable("1-projects/alpha/diagram.png")
    );

    // (b) the second search re-uses the index: no O(N) body reads
    bucket.resetCounts();
    const secondOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const ownerHitCount = (secondOwner.match(/^1-projects\//gm) || []).length;
    check(
      "a second search re-uses the index rather than re-reading the bucket",
      bucket.counts.noteGets.length <= ownerHitCount &&
        bucket.counts.noteGets.length < builtIndex.docs.size &&
        bucket.counts.put === 0
    );
    check(
      "and it still answers, so the reuse is not an empty answer",
      secondOwner.includes("1-projects/alpha/protocol.md") &&
        secondOwner.includes("1-projects/vault/secret.md")
    );

    // (d) THE PRIVACY LINE. The index was built by an owner-scope search above,
    // so it holds the private note's path, title, terms and vocabulary. A
    // team-scope search over the shared term must disclose none of it — not the
    // path, not a snippet, and not a count that counts it.
    bucket.resetCounts();
    const teamSearch = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    check(
      "a team search over an owner-built index surfaces only the team-visible note",
      typeof teamSearch === "string" &&
        teamSearch.includes("1-projects/alpha/protocol.md") &&
        !teamSearch.includes("1-projects/vault/secret.md") &&
        !teamSearch.includes("vault")
    );
    check(
      "no byte of the private note's text reaches a team connection",
      typeof teamSearch === "string" &&
        !teamSearch.includes("ZEBRAFISH-PRIVATE-MARKER") &&
        !teamSearch.includes("must never leave")
    );
    check(
      "the reported count is the count of visible matches, never of index matches",
      /^1 matching note$/m.test(teamSearch)
    );
    check(
      "and the same query at owner scope reports the larger count, so that is a filter and not a cap",
      /^2 matching notes$/m.test(secondOwner)
    );

    // (j) the prefix argument filters indexed results
    const prefixed = await searchText(env, OWNER_TOKEN, {
      query: "alpha",
      prefix: "1-projects/alpha",
    });
    check(
      "a prefix argument filters the indexed results to that subtree",
      prefixed.includes("1-projects/alpha/") &&
        !prefixed.includes("1-projects/beta/") &&
        !prefixed.includes("2-areas/")
    );

    // the ChatGPT dialect rides the same path and the same filter
    const teamDialect = JSON.parse(
      (await callTool(env, TEAM_TOKEN, "search", { query: "zebrafish" }))?.content?.[0]?.text
    );
    check(
      "the ChatGPT dialect shares the indexed path and its visibility filter",
      Array.isArray(teamDialect.results) &&
        teamDialect.results.length === 1 &&
        teamDialect.results[0].id === "1-projects/alpha/protocol.md" &&
        typeof teamDialect.results[0].title === "string" &&
        teamDialect.results[0].title.length > 0 &&
        !JSON.stringify(teamDialect).includes("ZEBRAFISH-PRIVATE-MARKER")
    );

    // (e) an edit is picked up by the etag diff; a deletion disappears
    bucket.seed(
      "1-projects/beta/plan.md",
      "# Beta plan\n\nBeta now mentions the OCTOPUS milestone.\n"
    );
    bucket.remove("1-projects/alpha/notes.md");
    const afterEdit = await searchText(env, OWNER_TOKEN, { query: "octopus" });
    check(
      "a note edited after indexing is re-indexed on the next search",
      afterEdit.includes("1-projects/beta/plan.md") && afterEdit.includes("OCTOPUS")
    );
    const afterDelete = await searchText(env, OWNER_TOKEN, { query: "pangolin" });
    check(
      "a deleted note disappears from results and from the index",
      afterDelete.includes("(no matches)") &&
        !storedIndex(bucket).docs.has("1-projects/alpha/notes.md")
    );

    // (f) a corrupt index is a rebuild, never a throw and never a wrong answer
    bucket.seed(SEARCH_INDEX_KEY, "{ this is not the index you are looking for");
    const afterCorrupt = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a corrupt index object still answers correctly",
      afterCorrupt.includes("1-projects/alpha/protocol.md") &&
        afterCorrupt.includes("1-projects/vault/secret.md")
    );
    check(
      "and is replaced with a valid one",
      storedIndex(bucket) !== null && storedIndex(bucket).docs.size > 0
    );

    // (g) a conditional-put conflict is a skipped write, not a retry loop
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nA CUTTLEFISH joins the milestone.\n");
    bucket.resetCounts();
    bucket.setBeforePut((key, options) => {
      // Somebody else's sync landed between our read and our write. Changing the
      // stored etag makes the real precondition fail, rather than simulating it.
      if (key === SEARCH_INDEX_KEY && options?.onlyIf) {
        const stored = bucket.objects.get(key);
        if (stored) stored.etag = `${stored.etag}-raced`;
      }
    });
    const afterConflict = await searchText(env, OWNER_TOKEN, { query: "cuttlefish" });
    const conflictPuts = bucket.counts.put;
    bucket.setBeforePut(null);
    check(
      "a lost conditional write still answers the query it was serving",
      afterConflict.includes("1-projects/beta/plan.md")
    );
    check(
      "and does not retry: one attempt, then on with the query",
      conflictPuts === 1 && bucket.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET
    );

    // The count's floor is read off what the caller can see, and this is the
    // channel that leaks by arithmetic rather than by content. Fifty-odd
    // private notes carrying the same term fill `searchIndex`'s ranked list; a
    // "+" on a team connection's count would be one bit about every one of them
    // — the same subtraction the census is owner-only to prevent.
    for (let n = 0; n < 55; n += 1) {
      bucket.seed(
        `1-projects/vault/bulk-${String(n).padStart(3, "0")}.md`,
        `# Vault bulk ${n}\n\nZEBRAFISH again, privately, number ${n}.\n`
      );
    }
    const bucketStore = new R2Store(bucket);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pass = await syncIndex(bucketStore, { budget: createSearchBudget(300) });
      if (pass.pending === 0) break;
    }
    const teamAfterBulk = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    const ownerAfterBulk = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a ranked list full of private matches puts no floor marker on a team connection's count",
      /^1 matching note$/m.test(teamAfterBulk) && !teamAfterBulk.includes("+ matching")
    );
    check(
      "while the connection that can see them is told its own count is a floor",
      /^50\+ matching notes/m.test(ownerAfterBulk)
    );

    // -- (c)/(h) a bucket too large to index in one pass ---------------------
    big.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 65; n += 1) {
      big.seed(
        `1-projects/bulk/note-${String(n).padStart(3, "0")}.md`,
        `# Bulk note ${n}\n\nEvery bulk note mentions the widget, this one is number ${n}.\n`
      );
    }

    big.resetCounts();
    const bigFirst = await searchText(env, BIG_TOKEN, { query: "widget" });
    const bigFirstOps = big.ops;
    check(
      "one search on a 65-note context stays inside the subrequest budget",
      bigFirstOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        bigFirstOps < SUBREQUEST_LIMIT
    );
    check(
      "and it answers rather than failing on the notes it did reach",
      typeof bigFirst === "string" && bigFirst.includes("1-projects/bulk/note-")
    );
    check(
      "a backfill that ran out of budget says so, in the floor language the census uses",
      bigFirst.includes("still catching up")
    );
    check(
      "and the floor carries no count, which would be a fact about notes the caller may not see",
      !/still catching up[^\]]*\d/.test(bigFirst)
    );

    big.resetCounts();
    const bigSecond = await searchText(env, BIG_TOKEN, { query: "widget" });
    check(
      "the second search on that context is bounded too, and continues the backfill",
      big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET && big.counts.put === 1
    );
    check(
      "results stay bounded at the result limit however many notes match",
      (bigSecond.match(/^1-projects\/bulk\//gm) || []).length <= SEARCH_RESULT_LIMIT
    );

    // The module directly, where `pending` is visible as a number rather than
    // as a sentence.
    const bigStore = new R2Store(big);
    // From no index at all, which is what a first search on a context this size
    // actually faces — the two searches above have already backfilled part of it.
    big.remove(SEARCH_INDEX_KEY);
    const pass = await syncIndex(bigStore, {
      budget: createSearchBudget(SEARCH_SUBREQUEST_BUDGET),
      reserve: SEARCH_RESULT_LIMIT,
    });
    check(
      "syncIndex reports the notes it did not reach rather than pretending it finished",
      pass.pending > 0 && pass.spent <= SEARCH_SUBREQUEST_BUDGET - SEARCH_RESULT_LIMIT
    );
    // Run it out: a bounded loop of bounded passes must converge, or the
    // backfill is a treadmill.
    let converged = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      converged = await syncIndex(bigStore, { budget: createSearchBudget(200) });
      if (converged.pending === 0) break;
    }
    check(
      "and repeated passes converge on a complete index",
      converged.pending === 0 && converged.index.docs.size === 65
    );
    check(
      "a converged index re-syncs without re-reading a single note body",
      await (async () => {
        big.resetCounts();
        const idle = await syncIndex(bigStore, { budget: createSearchBudget(200) });
        return idle.pending === 0 && big.counts.noteGets.length === 0 && big.counts.put === 0;
      })()
    );
    check(
      "searchIndex never returns more than the rank cap the tool's floor language assumes",
      searchIndex(converged.index, "widget").length === RANK_CAP
    );

    // A backend whose listings carry no etag at all — Dropbox lists
    // `server_modified` and `size` and nothing else. The diff has to converge
    // on those two or the index is rebuilt from scratch on every single search,
    // which is the failure this whole module exists to remove wearing a
    // different hat.
    const dropboxish = createBucket();
    dropboxish.listEtags = false;
    dropboxish.seed("privacy.md", PRIVACY_MANIFEST);
    dropboxish.seed("1-projects/one.md", "# One\n\nA NARWHAL swims past.\n");
    dropboxish.seed("1-projects/two.md", "# Two\n\nAnother NARWHAL entirely.\n");
    const dropboxStore = new R2Store(dropboxish);
    const firstPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    dropboxish.resetCounts();
    const secondPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    check(
      "a listing with no etag still converges, on the timestamp and size it does report",
      firstPass.index.docs.size === 2 &&
        secondPass.pending === 0 &&
        dropboxish.counts.noteGets.length === 0 &&
        dropboxish.counts.put === 0 &&
        searchIndex(secondPass.index, "narwhal").length === 2
    );

    // -- (i) the index path fails outright, and the scan catches the call ----
    broken.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 40; n += 1) {
      broken.seed(
        `1-projects/fallback/note-${String(n).padStart(3, "0")}.md`,
        `# Fallback ${n}\n\nThis one mentions the LIGHTHOUSE marker.\n`
      );
    }
    // The index object itself is unreadable: a storage error on the very first
    // call of the sync, which is what a revoked key or a 500 looks like here.
    broken.failGetKeys.add(SEARCH_INDEX_KEY);
    broken.resetCounts();
    const fallback = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a search whose index is unreachable answers from the capped scan instead of throwing",
      typeof fallback === "string" && fallback.includes("1-projects/fallback/note-")
    );
    check(
      "the capped scan says what it scanned rather than implying it saw everything",
      /scanned \d+ of \d+\+? notes/.test(fallback)
    );
    check(
      "and the recovery path is bounded too — this is where the original bug lived",
      broken.ops < SUBREQUEST_LIMIT
    );

    // A wide bucket, not just a deep one. The scan's listing walks every
    // top-level folder, and listings are store ops like any other: enough
    // folders is enough subrequests before the first note is read, so an
    // un-counted listing re-creates the original failure through the recovery
    // route. The budget has to cut the walk, and the cut has to surface as a
    // floor, not as a precise-looking total.
    for (let n = 0; n < 45; n += 1) {
      broken.seed(`area-${String(n).padStart(2, "0")}/note.md`, "# Wide\n\nLIGHTHOUSE here too.\n");
    }
    broken.resetCounts();
    const wide = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a wide bucket cannot spend the recovery path past the budget on listings alone",
      typeof wide === "string" && broken.ops < SUBREQUEST_LIMIT
    );
    check(
      "and a budget-cut walk reports its total as a floor",
      /of \d+\+ notes/.test(wide)
    );
    broken.failGetKeys.delete(SEARCH_INDEX_KEY);
  } finally {
    restore?.();
  }
}
