/**
 * TEX KEEPS HOUSE, END TO END THROUGH `/agent` (owner, 2026-10-17).
 *
 * A housekeeping run reads the workspace's health, moves, archives and
 * rewrites what it is sure of, and logs every change with the line that puts
 * it back in `tex/housekeeping/<day>.md`. It never widens who sees anything,
 * never leaves the workspace, never touches Tex's own folder, the website, the
 * routines or a root note, and never cuts a note down. Nothing caps how much
 * it changes (owner, 2026-10-17: "remove limit"). Only
 * a first-party client that looks on its own may ask for one.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-17).
 *
 *  1. `housekeepingCallTool` letting set_visibility through.
 *     → "housekeeping refuses everything that widens, leaves, sends or creates" fails.
 *  2. `protectedReason` returning null for `tex/`.
 *     → "housekeeping leaves Tex's folder, routines, the website and root notes alone" fails.
 *  3. `MIN_KEPT_SHARE` check removed from write_note.
 *     → "a rewrite that drops most of a note is refused" fails.
 *  4. `housekeepingQuestion` ignoring its `instructions` (the setup note's words).
 *     → "the setup note's words replace the built-in ones; the run's facts stay" fails.
 *  5. `http/route.js` sending the texting client to housekeeping, and
 *     `handleHousekeeping` not checking the client itself.
 *     → "only housekeeping's own client keeps house" fails.
 *  7. The `@name/` path refusal removed.
 *     → "housekeeping refuses everything that widens, leaves, sends or creates" fails.
 *  8. A cap put back (150 notes, 30 calls).
 *     → "no cap: a big folder and every change after it go through" fails.
 *  9. The landing-folder check removed.
 *     → "housekeeping refuses everything that widens, leaves, sends or creates" fails.
 * 10. `roundCap` not passed to `runTurn` (a texted turn's eight rounds).
 *     → "a run gets more rounds than a texted turn's eight" fails.
 *  6. The whole-top-level-folder refusal removed.
 *     → "a move that touches a protected path at either end, or a whole
 *       top-level folder, is refused" fails.
 */

import worker from "../src/index.js";
import { SKIPPED_WORDS } from "../src/agent/jobLog.js";
import { HOUSEKEEPING_INSTRUCTIONS, housekeepingPath, housekeepingQuestion, chaosFrom, summaryLine } from "../src/agent/housekeeping.js";
import { housekeepingCallTool, protectedReason, undoLine } from "../src/agent/housekeepingGuard.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-housekeeping.test";
const TOKEN_HOUSE = `cat_house_house_${"0".repeat(23)}`;
const TOKEN_DREAMS = `cat_house_dreams_${"0".repeat(22)}`;
const TOKEN_TEXTS = `cat_house_texts_${"0".repeat(23)}`;
const TOKEN_MCP = `cat_house_mcp_${"0".repeat(25)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  4-archive: private\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    install(replies) {
      script = [...replies];
    },
    async handle(_url, init) {
      requests.push(JSON.parse(init.body));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      const next = typeof step === "function" ? step(JSON.stringify(requests.at(-1))) : step;
      const content = [];
      if (next.text) content.push({ type: "text", text: next.text });
      for (const [i, call] of (next.toolCalls ?? []).entries()) {
        content.push({ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.args ?? {} });
      }
      return new Response(
        JSON.stringify({ content, stop_reason: (next.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}

async function ask(env, token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/**
 * Where the note at `path` lives now, read through the gateway as a connected
 * client sees it (a move renames the tree, not the bucket, and an old name
 * follows the note), or null when there is none.
 */
async function whereIs(env, path) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_MCP}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_note", arguments: { path } } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  if (body?.result === undefined || body.result.isError === true) return null;
  return /^path: (.+)$/m.exec(body.result.content?.[0]?.text ?? "")?.[1] ?? null;
}

function unitChecks(check) {
  const theirs = housekeepingQuestion({ health: "Chaos 42 of 100 (messy).", today: "2026-10-17", instructions: "Only archive finished projects." });
  const built = housekeepingQuestion({ health: null, today: "2026-10-17" });
  check(
    "the setup note's words replace the built-in ones; the run's facts stay",
    theirs.startsWith("Only archive finished projects.") && !theirs.includes("The Supa way") &&
      theirs.includes("Today is 2026-10-17.") && theirs.includes("Chaos 42 of 100") && /first sentence/.test(theirs) &&
      built.startsWith(HOUSEKEEPING_INSTRUCTIONS) && /first sentence/.test(built),
  );
  check("the day's log is dated in their zone", housekeepingPath(Date.UTC(2026, 9, 17, 3, 0), "America/New_York") === "tex/housekeeping/2026-10-16.md");
  check("the score is read from the health answer", chaosFrom("## Chaos score\n\nChaos 42 of 100 (messy).") === 42 && chaosFrom("No score for this workspace yet.") === null);
  check(
    "housekeeping leaves Tex's folder, routines, the website and root notes alone",
    ["tex/about-me.md", "tex", "routines/daily/x.md", "website/index.md", ".context/x.json", "todo.md", "index.md", ""].every((path) => protectedReason(path) !== null) &&
      ["1-projects/x/overview.md", "1-projects/x", "2-areas/apps/", "4-archive/1-projects/x/"].every((path) => protectedReason(path) === null),
  );
  check(
    "Tex's folder and the website's are left alone wherever a person nested them",
    protectedReason("Life/Assistant/about-me.md", ["Life/Assistant"]) !== null &&
      protectedReason("Life/Assistant", ["Life/Assistant/"]) !== null &&
      protectedReason("Life/Assistants/x.md", ["Life/Assistant"]) === null &&
      protectedReason("Life/Assistant/about-me.md") === null,
  );
  check(
    "every change says how to put it back",
    undoLine({ do: "moved", from: "a/b.md", to: "c/b.md" }) === "move `c/b.md` back to `a/b.md`" &&
      undoLine({ do: "archived", path: "a.md", from: "a/x.md", to: "4-archive/x.md" }).includes("4-archive/x.md") &&
      undoLine({ do: "rewrote", path: "a/x.md" }).includes("history"),
  );
  check(
    "the text line is the account's first sentence, and nothing when nothing changed",
    summaryLine("I archived 2 finished projects. Then I rested.", [{}, {}]) === "I archived 2 finished projects." &&
      summaryLine("Nothing needed doing.", []) === "",
  );
}

async function toolRefusals(check) {
  const calls = [];
  const notes = new Map([["1-projects/x/overview.md", "---\nstatus: in progress\n---\n\n# X\n\nA long enough body of text to keep.\n"]]);
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note") {
      const body = notes.get(args.path);
      return body === undefined
        ? { isError: true, content: [{ type: "text", text: "not found" }] }
        : { content: [{ type: "text", text: `etag: e1\npath: ${args.path}\n\n${body}` }] };
    }
    if (name === "list_notes") {
      // Three top-level folders with notes in them; `1-projects/big/` holds 40.
      const listing = {
        "1-projects/": ["1-projects/x/overview.md"],
        "2-areas/": ["2-areas/a.md"],
        "4-archive/": ["4-archive/old.md"],
        "1-projects/big/": Array.from({ length: 40 }, (_, i) => `1-projects/big/n${i}.md`),
      }[args.prefix] ?? [];
      return { content: [{ type: "text", text: listing.map((path) => `${path} (10 bytes)`).join("\n") }] };
    }
    return { content: [{ type: "text", text: name === "archive_note" ? `archived: ${args.path} → 4-archive/2026-10-17-x.md` : "ok" }] };
  };
  const changing = () => calls.filter((call) => !["read_note", "list_notes"].includes(call.name));
  const guard = housekeepingCallTool(dispatch);
  const refusals = await Promise.all([
    guard.callTool("set_visibility", { path: "1-projects/x/overview.md", visibility: "team" }),
    guard.callTool("create_link", { path: "1-projects/x/overview.md" }),
    guard.callTool("send_email", { to: "a@example.com" }),
    guard.callTool("move_note", { source: "1-projects/x/a.md", destination: "2-areas/a.md", context: "@other" }),
    guard.callTool("move_note", { source: "1-projects/x/a.md", destination: "2-areas/a.md", destination_context: "@other" }),
    guard.callTool("move_note", { source: "1-projects/x/a.md", destination: "2-areas/a.md", confirm_team_publish: true }),
    guard.callTool("write_note", { path: "1-projects/new.md", content: "# New\n" }),
    guard.callTool("read_note", { path: "x.md", context: "@other" }),
    guard.callTool("archive_note", { path: "@me/tex/routines/daily/x.md" }),
    guard.callTool("write_note", { path: "@me/website/index.md", content: "x", expected_etag: "e1" }),
    guard.callTool("move_note", { source: "2-areas/a.md", destination: "@team/2-areas/a.md" }),
    guard.callTool("move_notes", { moves: [{ source: "2-areas/a.md", destination: "/@team/2-areas/a.md" }] }),
    guard.callTool("move_note", { source: "2-areas/a.md", destination: "newfolder/a.md" }),
  ]);
  check(
    "housekeeping refuses everything that widens, leaves, sends or creates",
    refusals.every((result) => result.isError === true) && changing().length === 0 && guard.changes.length === 0,
  );
  const protectedMoves = await Promise.all([
    guard.callTool("move_folder", { source: "tex", destination: "4-archive/tex" }),
    guard.callTool("move_folder", { source: "1-projects", destination: "4-archive/1-projects" }),
    guard.callTool("move_folder", { source: "2-areas/", destination: "3-resources/areas" }),
    guard.callTool("move_note", { source: "1-projects/x/a.md", destination: "website/a.md" }),
    guard.callTool("archive_note", { path: "todo.md" }),
    guard.callTool("move_notes", { moves: [{ source: "1-projects/x/a.md", destination: "2-areas/a.md" }, { source: "routines/daily/r.md", destination: "2-areas/r.md" }] }),
  ]);
  check("a move that touches a protected path at either end, or a whole top-level folder, is refused", protectedMoves.every((result) => result.isError === true) && changing().length === 0);

  const cut = await guard.callTool("write_note", { path: "1-projects/x/overview.md", content: "# X\n", expected_etag: "e1" });
  check("a rewrite that drops most of a note is refused", cut.isError === true && !calls.some((call) => call.name === "write_note"));

  const status = await guard.callTool("write_note", {
    path: "1-projects/x/overview.md",
    content: "---\nstatus: finished\n---\n\n# X\n\nA long enough body of text to keep.\n",
    expected_etag: "e1",
  });
  const archived = await guard.callTool("archive_note", { path: "1-projects/x/notes.md" });
  const moved = await guard.callTool("move_note", { source: "2-areas/thin/only.md", destination: "2-areas/only.md" });
  check(
    "allowed changes go through and are logged, archives with where they went",
    status.isError !== true && archived.isError !== true && moved.isError !== true &&
      JSON.stringify(guard.changes) ===
        JSON.stringify([
          { do: "rewrote", path: "1-projects/x/overview.md" },
          { do: "archived", path: "1-projects/x/notes.md", from: "1-projects/x/notes.md", to: "4-archive/2026-10-17-x.md" },
          { do: "moved", from: "2-areas/thin/only.md", to: "2-areas/only.md" },
        ]),
  );
  const over = await guard.callTool("move_note", { source: "2-areas/a.md", destination: "2-areas/b/a.md" });
  const big = await guard.callTool("move_folder", { source: "1-projects/big", destination: "4-archive/1-projects/big" });
  check(
    "no cap: a big folder and every change after it go through",
    over.isError !== true && big.isError !== true && guard.changes.length === 5,
  );
}

export async function runAgentHousekeepingChecks(check) {
  unitChecks(check);
  await toolRefusals(check);

  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) return model.handle(url, init);
    return withStubs(input, init);
  };

  try {
    controlPlane.addWorkspace("ws_house", "housekeeper", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-house",
      accessKeyId: "AKIAEXAMPLEEXAMPLEHK",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEHK",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: "ws_house",
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_house",
      });
    await grant(TOKEN_HOUSE, "context_housekeeping");
    await grant(TOKEN_DREAMS, "context_dreams");
    await grant(TOKEN_TEXTS, "context_texts");
    await grant(TOKEN_MCP, "client_house_mcp");
    controlPlane.setBuiltinVerdict("ws_house", BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-house");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "h0" });
    bucket.set("todo.md", { body: "# To do\n\n- Pay rent\n", etag: "h1" });
    bucket.set("1-projects/garden/overview.md", { body: "---\nstatus: finished\n---\n\n# Garden beds\n\nAll four beds built and planted.\n", etag: "h2" });
    bucket.set("1-projects/garden/plan.md", { body: "# Plan\n\nWood, soil, seeds.\n", etag: "h3" });
    bucket.set("2-areas/health/only.md", { body: "# Dentist\n\nEvery six months.\n", etag: "h4" });
    bucket.set("tex/about-me.md", { body: "# About them\n\n- Likes tea\n", etag: "h5" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const log = () => bucket.get(housekeepingPath(Date.now(), "UTC"))?.body ?? "";
    const run = { housekeeping: { timeZone: "UTC" } };

    /* ---------------- who keeps house ---------------- */

    const texted = await ask(env, TOKEN_TEXTS, run);
    const dreamt = await ask(env, TOKEN_DREAMS, run);
    check(
      "only housekeeping's own client keeps house",
      texted.status !== 200 && dreamt.status !== 200 && model.requests.length === 0 && (await whereIs(env, "1-projects/garden/overview.md")) === "1-projects/garden/overview.md",
    );

    /* ---------------- a run that tidies ---------------- */

    model.install([
      {
        toolCalls: [
          { name: "list_notes", args: { prefix: "1-projects/" } },
          { name: "read_note", args: { path: "1-projects/garden/overview.md" } },
        ],
      },
      {
        toolCalls: [
          { name: "move_folder", args: { source: "1-projects/garden", destination: "4-archive/1-projects/garden" } },
          { name: "move_note", args: { source: "2-areas/health/only.md", destination: "2-areas/dentist.md" } },
          { name: "move_note", args: { source: "tex/about-me.md", destination: "2-areas/about-me.md" } },
          { name: "set_visibility", args: { path: "2-areas/dentist.md", visibility: "team" } },
        ],
      },
      { text: "I archived the finished garden project and pulled your dentist note out of a one-note folder. Both were clear." },
    ]);
    const tidied = await ask(env, TOKEN_HOUSE, run);
    check(
      "a run archives a finished project and collapses a one-note folder",
      tidied.status === 200 &&
        tidied.body?.outcome === "tidied" &&
        tidied.body?.changes === 2 &&
        tidied.body?.line === "I archived the finished garden project and pulled your dentist note out of a one-note folder." &&
        (await whereIs(env, "1-projects/garden/overview.md")) === "4-archive/1-projects/garden/overview.md" &&
        (await whereIs(env, "2-areas/health/only.md")) === "2-areas/dentist.md",
    );
    check("a run never moves Tex's own notes", (await whereIs(env, "tex/about-me.md")) === "tex/about-me.md" && (await whereIs(env, "2-areas/about-me.md")) === null);
    const written = log();
    check(
      "the log names every change with how to undo it, the account, and every step",
      written.startsWith("# Tex kept house,") &&
        written.includes("- Moved the folder `1-projects/garden` to `4-archive/1-projects/garden`. To undo: move `4-archive/1-projects/garden` back to `1-projects/garden`.") &&
        written.includes("- Moved `2-areas/health/only.md` to `2-areas/dentist.md`. To undo:") &&
        written.includes("Both were clear.") &&
        written.includes("`set_visibility`") &&
        !written.includes("Moved `tex/about-me.md`"),
    );
    const prompt = JSON.stringify(model.requests[0]);
    check("the run is told the Supa way and its jobs", prompt.includes("housekeeping run") && prompt.includes("PARA") && prompt.includes("Finished projects"));

    /* ---------------- a run with nothing to do ---------------- */

    model.install([{ text: "Everything here is already where it belongs." }]);
    const calm = await ask(env, TOKEN_HOUSE, run);
    check(
      "a run that changes nothing says so, in the same day's log, and texts nothing",
      calm.status === 200 && calm.body?.outcome === "unchanged" && calm.body?.line === "" && log().includes("_Nothing changed._") &&
        (log().match(/^## /gm) ?? []).length === 2,
    );

    /* ---------------- a long run is not cut at a texted turn's rounds ---------------- */

    const reading = Array.from({ length: 12 }, () => ({ toolCalls: [{ name: "list_notes", args: { prefix: "2-areas/" } }] }));
    model.install([...reading, { text: "I looked through everything and it is already in order." }]);
    const sent = model.requests.length;
    const long = await ask(env, TOKEN_HOUSE, run);
    check(
      "a run gets more rounds than a texted turn's eight",
      long.status === 200 && long.body?.outcome === "unchanged" && model.requests.length - sent === 13 && log().includes("already in order"),
    );

    /* ---------------- no model to run ---------------- */

    const modelRequests = model.requests.length;
    controlPlane.setBuiltinVerdict("ws_house", { allowed: false, reason: "daily_cap" });
    const capped = await ask(env, TOKEN_HOUSE, run);
    controlPlane.setBuiltinVerdict("ws_house", BUILTIN_ALLOWED);
    check(
      "a run past today's cap runs no model and says so in the day's log",
      capped.status === 429 && model.requests.length === modelRequests && log().includes(`_${SKIPPED_WORDS.daily_limit}_`),
    );

    /* ---------------- the client does nothing else ---------------- */

    const before = model.requests.length;
    const asked = await ask(env, TOKEN_HOUSE, { question: "tidy up" });
    check("housekeeping's client asking anything else is refused, and costs no model turn", asked.status === 400 && model.requests.length === before);
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
