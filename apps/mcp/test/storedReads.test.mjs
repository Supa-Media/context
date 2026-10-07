/**
 * STORED READS — what AI clients read, kept in the customer's bucket for the
 * trail (`list_changes` with `reads: true`) and the map's replay
 * (`GET /agent-activity?reads_from=`). See `src/live/readLog.js`.
 *
 * A stored read is a path, and a path is the customer's data, so most of
 * these are about who is *not* told:
 *
 *  1. **A team member never sees a read of a note that was private when it
 *     was read**, even once the note is shared — nor one private now.
 *  2. **Only the console asks for a replay's reads**; a tool gets none here.
 *  3. **Another workspace's reads never leak.**
 *  4. **A lost or stale roll-up loses no read**, and a short answer says so.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines in this
 * suite.
 *
 *   `readFilterFor` ignores `team_visible` (event-time flag)               3
 *   `readFilterFor` skips `canSee` (live manifest)                         3
 *   route answers any client, not only the console                         1
 *   `readDay` reads no objects once a roll-up exists                       1
 *   `readsBetween` never reports `truncated`                               2
 *   console reads recorded as an AI's                                      5
 */

import { READ_LOG_MAX_SPAN_MS, readsBetween, storageBudget } from "../src/live/readLog.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { activityRequest, callTool, createBucket, createLiveNamespace } from "./agentActivityFixtures.mjs";

const T = (name) => `cat_storedreads_${name}_`.padEnd(32, "0");
const OWNER = T("owner");
const TEAM = T("team");
const CONSOLE_OWNER = T("cowner");
const CONSOLE_TEAM = T("cteam");
const CONSOLE_OTHER = T("cother");

const manifest = (overrides = "  1-projects/rates.md: private\n") =>
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  `note_overrides:\n${overrides}\`\`\`\n\n` +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function counted(bucket) {
  const counts = { ops: 0, gets: 0 };
  const wrapped = { counts, seed: (...args) => bucket.seed(...args) };
  for (const name of ["get", "put", "delete", "list", "head"]) {
    if (typeof bucket[name] !== "function") continue;
    wrapped[name] = (...args) => {
      counts.ops += 1;
      if (name === "get") counts.gets += 1;
      return bucket[name](...args);
    };
  }
  return wrapped;
}

const readKeys = async (bucket) =>
  (await bucket.list({ prefix: ".context/reads/" })).objects.map((object) => object.key);

export async function runStoredReadsChecks(check) {
  /* ========================= the pure module ============================ */
  {
    const bucket = createBucket();
    const day = "2026-10-07";
    const record = (minute, path, extra = {}) => ({
      at: `${day}T10:${String(minute).padStart(2, "0")}:00.000Z`,
      tool: "read_note",
      path,
      by: "@seyi",
      via: "Claude",
      team_visible: true,
      ...extra,
    });
    for (let minute = 0; minute < 30; minute += 1) {
      bucket.seed(`.context/reads/${day}/${day}T10-${String(minute).padStart(2, "0")}-00-000Z-x${minute}.json`, JSON.stringify(record(minute, `n${minute}.md`)));
    }
    const from = Date.parse(`${day}T00:00:00Z`);
    const to = Date.parse(`${day}T23:00:00Z`);
    const all = (record) => record.path;

    const short = await readsBetween(bucket, { from, to, budget: storageBudget(12), visible: all });
    check(
      "a budget too small for the day answers what it gathered, newest first, and says it is short",
      short.truncated === true && short.reads.length > 0 && short.reads.length < 30 &&
        short.reads.at(-1).path === "n29.md",
    );
    const sizes = [short.reads.length];
    let last = short;
    for (let ask = 0; ask < 5 && last.truncated; ask += 1) {
      last = await readsBetween(bucket, { from, to, budget: storageBudget(12), visible: all });
      sizes.push(last.reads.length);
    }
    check(
      "the roll-up grows with each ask until the day is whole",
      last.reads.length === 30 && last.truncated === false && sizes.every((size, i) => i === 0 || size > sizes[i - 1]),
    );
    await bucket.delete(`.context/reads/${day}.json`);
    const rebuilt = await readsBetween(bucket, { from, to, budget: storageBudget(100), visible: all });
    check("a lost roll-up loses no read", rebuilt.reads.length === 30 && rebuilt.truncated === false);
    bucket.seed(`.context/reads/${day}.json`, JSON.stringify({ version: 1, records: [] }));
    const stale = await readsBetween(bucket, { from, to, budget: storageBudget(100), visible: all });
    check("a stale roll-up is filled in from the reads themselves", stale.reads.length === 30);
    bucket.seed(
      `.context/reads/${day}.json`,
      JSON.stringify({ version: 1, records: [{ ...record(1, "invented.md"), key: `.context/reads/${day}/nope.json` }] }),
    );
    const planted = await readsBetween(bucket, { from, to, budget: storageBudget(100), visible: all });
    check(
      "a roll-up entry no read object stands behind is not a read",
      !planted.reads.some((read) => read.path === "invented.md") && planted.reads.length === 30,
    );

    const windowed = await readsBetween(bucket, {
      from: Date.parse(`${day}T10:10:00Z`),
      to: Date.parse(`${day}T10:19:59Z`),
      budget: storageBudget(100),
      visible: all,
    });
    check(
      "only reads inside the window come back, oldest first",
      windowed.reads.length === 10 && windowed.reads[0].path === "n10.md" && windowed.reads.at(-1).path === "n19.md",
    );
    const filtered = await readsBetween(bucket, {
      from,
      to,
      budget: storageBudget(100),
      visible: (read) => (read.path === "n3.md" ? null : `moved/${read.path}`),
    });
    check(
      "the filter decides each read and the path it shows",
      !filtered.reads.some((read) => read.path.endsWith("/n3.md")) && filtered.reads.every((read) => read.path.startsWith("moved/")),
    );
    const listedDays = [];
    const spy = {
      ...bucket,
      list: async (options) => {
        listedDays.push(options.prefix);
        return bucket.list(options);
      },
    };
    await readsBetween(spy, { from: to - 30 * 24 * 60 * 60_000, to, budget: storageBudget(500), visible: all });
    check(
      "one ask never covers more than its span",
      listedDays.length > 0 && listedDays.length <= READ_LOG_MAX_SPAN_MS / (24 * 60 * 60_000) + 1,
    );
  }

  /* ============================== the route ============================= */

  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = counted(createBucket());
    const otherBucket = createBucket();
    const binding = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      provider: "r2-binding",
    };
    controlPlane.addWorkspace("ws_storedreads", "storedreadstest", { ...binding, bindingName: "READS_BUCKET" });
    controlPlane.addWorkspace("ws_storedreadsother", "storedreadsother", { ...binding, bindingName: "READS_OTHER" });
    const grant = (accessToken, workspaceId, role, scopes, clientId, userId) =>
      controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId, clientName: "Claude", userId });
    const all = ["context:read", "context:write", "context:private"];
    const team = ["context:read", "context:write"];
    await grant(OWNER, "ws_storedreads", "owner", all, "mcp_client_storedreads_owner", "user_storedreads_owner");
    await grant(TEAM, "ws_storedreads", "editor", team, "mcp_client_storedreads_team", "user_storedreads_team");
    await grant(CONSOLE_OWNER, "ws_storedreads", "owner", all, "context_console", "user_storedreads_owner");
    await grant(CONSOLE_TEAM, "ws_storedreads", "editor", team, "context_console", "user_storedreads_team");
    await grant(CONSOLE_OTHER, "ws_storedreadsother", "owner", all, "context_console", "user_storedreads_other");

    bucket.seed("privacy.md", manifest());
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/roadmap.md", "the roadmap");
    bucket.seed("1-projects/rates.md", "RATESECRET");
    bucket.seed("1-projects/later.md", "a team note that will be made private");
    otherBucket.seed("privacy.md", manifest());
    otherBucket.seed("1-projects/elsewhere.md", "another workspace's note");

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "READS_BUCKET,READS_OTHER",
      READS_BUCKET: bucket,
      READS_OTHER: otherBucket,
      PRESENCE_ROOM: createLiveNamespace(),
    };
    const started = Date.now() - 1000;
    const ask = async (token, params = {}) =>
      (await activityRequest(env, token, {
        query: `?${new URLSearchParams({ reads_from: String(started), ...params })}`,
      })).body ?? {};

    await callTool(env, TEAM, "read_note", { path: "index.md" });
    await callTool(env, TEAM, "read_note", { path: "1-projects/roadmap.md" });
    await callTool(env, TEAM, "read_note", { path: "1-projects/rates.md" }); // refused: records nothing
    await callTool(env, TEAM, "read_note", { path: "1-projects/later.md" });
    await callTool(env, OWNER, "read_note", { path: "1-projects/rates.md" });
    await callTool(env, CONSOLE_OWNER, "read_note", { path: "1-projects/roadmap.md" });
    await callTool(env, CONSOLE_OTHER, "read_note", { path: "1-projects/elsewhere.md" });

    const keys = await readKeys(bucket);
    const stored = await Promise.all(keys.map(async (key) => JSON.parse(await (await bucket.get(key)).text())));
    check(
      "each read an AI client made is stored once, under its day, and a refused read is not",
      keys.length === 4 && keys.every((key) => /^\.context\/reads\/\d{4}-\d{2}-\d{2}\/.+\.json$/.test(key)) &&
        stored.filter((record) => record.path === "1-projects/rates.md").length === 1,
    );
    check(
      "a record names the note, the tool and who, as the activity feed names them",
      stored.some((record) => record.path === "index.md" && record.tool === "read_note" && record.via === "Claude" &&
        record.actor_client_id === "mcp_client_storedreads_team" && record.workspace_id === "ws_storedreads"),
    );
    check(
      "the private note's read is marked as not team-visible when it was read",
      stored.find((record) => record.path === "1-projects/rates.md")?.team_visible === false &&
        stored.find((record) => record.path === "index.md")?.team_visible === true,
    );
    check(
      "a person opening a note in the console is not stored as an AI reading it",
      !stored.some((record) => record.actor_client_id === "context_console"),
    );
    check("nothing about this workspace's reads lands in another's bucket", (await readKeys(otherBucket)).length === 0);

    // The owner shares the private note, and makes a team note private.
    bucket.seed("privacy.md", manifest("  1-projects/later.md: private\n"));
    const teamView = await ask(CONSOLE_TEAM);
    const ownerView = await ask(CONSOLE_OWNER);
    const teamPaths = (teamView.reads ?? []).map((read) => read.path);
    check(
      "a teammate's replay has the team reads, oldest first, with who made them",
      JSON.stringify(teamPaths) === JSON.stringify(["index.md", "1-projects/roadmap.md"]) &&
        teamView.reads.every((read) => read.via === "Claude" && Number.isFinite(read.at)),
    );
    check(
      "a read of a note private when it was read stays hidden from the team after it is shared",
      !teamPaths.includes("1-projects/rates.md"),
    );
    check("a read of a note private now is hidden from the team", !teamPaths.includes("1-projects/later.md"));
    check(
      "the owner's replay has every read, the private ones included",
      ["index.md", "1-projects/roadmap.md", "1-projects/later.md", "1-projects/rates.md"].every((path) =>
        (ownerView.reads ?? []).some((read) => read.path === path),
      ),
    );
    check(
      "a tool asking for a replay's reads gets none",
      Array.isArray((await ask(TEAM)).reads) && (await ask(TEAM)).reads.length === 0 &&
        (await ask(OWNER)).reads.length === 0,
    );
    const other = await ask(CONSOLE_OTHER);
    check(
      "another workspace's replay has none of this one's reads, and none of its own console's",
      other.reads.length === 0,
    );
    check(
      "a window that ends before the reads holds none of them",
      (await ask(CONSOLE_OWNER, { reads_to: String(started - 10) })).reads.length === 0,
    );

    // A note moved after it was read is shown where it is now.
    await callTool(env, OWNER, "move_note", { source: "1-projects/roadmap.md", destination: "1-projects/done/roadmap.md" });
    const moved = (await ask(CONSOLE_TEAM)).reads.map((read) => read.path);
    check(
      "a read is shown on the note where it is now",
      moved.includes("1-projects/done/roadmap.md") && !moved.includes("1-projects/roadmap.md"),
    );

    const before = bucket.counts.gets;
    await ask(CONSOLE_OWNER);
    const cost = bucket.counts.gets - before;
    check("once the day is rolled up, a replay reads no single read objects", cost <= 4);

    // ---- the trail ----
    const ownerTrail = await callTool(env, OWNER, "list_changes", { reads: true, limit: 50 });
    const teamTrail = await callTool(env, TEAM, "list_changes", { reads: true, limit: 50 });
    const plainTrail = await callTool(env, OWNER, "list_changes", { limit: 50 });
    check(
      "list_changes with reads lists who read what, beside the changes",
      /read \(read_note\) by .*Claude — 1-projects\/rates\.md/.test(ownerTrail) && ownerTrail.includes("move_note"),
    );
    check(
      "a teammate's trail never shows a read the replay would hide",
      !teamTrail.includes("rates.md") && !teamTrail.includes("later.md") && teamTrail.includes("index.md"),
    );
    check("list_changes without reads is unchanged", !plainTrail.includes("read (read_note)"));
  } finally {
    restore();
  }
}
