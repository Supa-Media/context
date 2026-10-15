/**
 * A THROWAWAY WORLD FOR ONE BENCHMARK CONVERSATION.
 *
 * The real gateway Worker, in process, over the same in-memory control plane
 * and object store its tests use. Every invented workspace becomes its own
 * bucket with a real `privacy.md`, every invented person a texting grant
 * covering exactly the workspaces `people.md` gives them, and the setup under
 * test is written where the product reads it: `ai/production/` in a
 * pinned `@context-lc`. So a benchmark answer goes through the same tools,
 * routing and privacy decisions a texted answer does, and a setup that leaks
 * a held-back note does it here first.
 *
 * Nothing leaves the world except the model calls: writes land in the
 * throwaway buckets and are read back as a list of changes, never applied
 * anywhere.
 *
 * A test may pin the day it is on (`today`, see clock.mjs): the world's clock
 * then reads that day, and each note's modified time comes from its own front
 * matter, so "untouched for a month" means the same on every run.
 */

import { TRANSCRIPTS_FOLDER } from "../src/agent/transcript.js";
import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { skillPath } from "../src/agent/skills.js";
import { createWeb } from "./sites.mjs";
import { createBenchSite } from "./siteStub.mjs";
import { PROPOSAL_PENDING_PREFIX } from "../src/tools/proposals.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "../test/controlPlaneStub.mjs";
import { readFileSync, rmSync } from "node:fs";

import { createWorkerCtx } from "../test/workerCtx.mjs";
import { ACCOUNT_ID as D1_ACCOUNT_ID, API_TOKEN as D1_API_TOKEN, CLOUDFLARE_API_BASE, createD1Backend } from "../test/searchProjection/fixtures.mjs";
import { createVectorizeBackend, meaningIndexFor } from "../test/vectorizeStub.mjs";
import { wireSearchSettings } from "../src/search/settings.js";
import { assertIsoDate, installClock, noonUtcMs, noteModifiedAt, realNow } from "./clock.mjs";

/** Brave's search endpoint (`src/agent/search.js`). */
const BRAVE_SEARCH = "https://api.search.brave.com/";

export const S3_ENDPOINT = "https://s3.bench.invalid";
const PINNED = "context-lc";

/**
 * The `privacy.md` the gateway reads. The default is always private (the engine
 * accepts nothing else), so a shared workspace shares each of its top-level
 * folders and root notes with members, and a held-back note is a private
 * override on top.
 */
/**
 * A var as the deployed gateway has it: the top-level `[vars]` of
 * wrangler.toml, never a per-environment table. `undefined` when unset.
 */
export function deployedVar(toml, name) {
  const top = toml.match(/^\[vars\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return top.match(new RegExp(`^${name} = "([^"]*)"\\s*$`, "m"))?.[1];
}

/**
 * The egress gate as production runs it. The owner switched it off on the
 * deployment (2026-10-10); a world that held writes anyway graded a YES round
 * trip production never has, and "tick off the to-do" failed on it.
 */
export const DEPLOYED_EGRESS_APPROVALS = deployedVar(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), "EGRESS_APPROVALS");

export function manifest({ shared, files = [], heldBack = [] }) {
  const folders = shared ? [...new Set(files.filter((path) => path.includes("/")).map((path) => path.split("/")[0]))].sort() : [];
  const rootNotes = shared ? files.filter((path) => !path.includes("/")).sort() : [];
  const lines = (entries, visibility) => entries.map((path) => `  ${path}: ${visibility}\n`).join("");
  const overrides = lines(rootNotes.filter((path) => !heldBack.includes(path)), "team") + lines(heldBack, "private");
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n${lines(folders, "team") || "  # none\n"}\n` +
    `note_overrides:\n${overrides || "  # none\n"}` +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

export function workspaceId(name) {
  return `ws_${name.replace(/-/g, "_")}`;
}

/** The search-database descriptor a warmed workspace carries (`search/d1/client.js`). */
export function searchIndexFor(name, state) {
  return { databaseId: `db-bench-${name}`, accountId: D1_ACCOUNT_ID, apiToken: D1_API_TOKEN, state };
}

export function binding(bucket, n, searchIndex = null, meaningIndex = null) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIABENCHEXAMPLE${String(n).padStart(4, "0")}`,
    secretAccessKey: `benchExampleSecretNotReal${String(n).padStart(4, "0")}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
    ...(searchIndex ? { searchIndex } : {}),
    ...(meaningIndex ? { meaningIndex } : {}),
  };
}

/**
 * The visibility a fixture note is written at, as `manifest` above declares it:
 * a shared workspace's notes are team unless held back by name, a personal
 * workspace's are private. The meaning index records the same tier.
 */
export function fixtureVisibility(bench, name, path) {
  const shared = !bench.people.some((row) => row.workspace === name && row.personal);
  if (!shared) return "private";
  return (bench.workspaces[name].heldBack ?? []).includes(path) ? "private" : "team";
}

function bodyText(object) {
  const body = object?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body ?? "");
}

function snapshot(bucket) {
  return new Map([...bucket].map(([key, object]) => [key, bodyText(object)]));
}

/**
 * Register every workspace and fill its bucket, from the fixture or from a
 * prepared run's snapshot. Every workspace exists whoever is asking, so a leak
 * is a real leak. `search` is `null` (no search database: the cold world),
 * `"backfilling"` (a database to warm) or `"ready"` (a warmed clone).
 */
export function placeWorkspaces(bench, { s3, controlPlane, baseMs, search = null, meaning = false, prepared = null }) {
  const modified = (ms) => new Date(ms).toISOString();
  const ids = new Map();
  let n = 0;
  for (const [name, workspace] of Object.entries(bench.workspaces)) {
    const id = workspaceId(name);
    const shared = !bench.people.some((row) => row.workspace === name && row.personal);
    const searchIndex = search ? searchIndexFor(name, search) : null;
    // Search by meaning rides beside fast search, on the same state: a world
    // with a meaning index is one whose warm pass filled it (`warm.mjs`).
    const meaningIndex = meaning && search ? meaningIndexFor(name, search, D1_ACCOUNT_ID) : null;
    controlPlane.addWorkspace(id, name, binding(`bench-${name}`, ++n, searchIndex, meaningIndex), shared ? { kind: "shared" } : {});
    const bucket = s3.bucketFor(`bench-${name}`);
    if (prepared) {
      // The warmed bucket, index shards included; each object copied so a turn's
      // write never reaches the snapshot.
      for (const [key, object] of prepared.buckets.get(name)) bucket.set(key, { ...object });
    } else {
      bucket.set("privacy.md", {
        body: manifest({ shared, files: Object.keys(workspace.files), heldBack: workspace.heldBack }),
        etag: "p0",
        lastModified: modified(baseMs),
      });
      for (const [path, text] of Object.entries(workspace.files)) {
        bucket.set(path, { body: text, etag: "e0", lastModified: modified(noteModifiedAt(text, baseMs)) });
      }
    }
    controlPlane.setBuiltinVerdict(id, { allowed: true, remaining: 1000 });
    ids.set(name, id);
  }
  return ids;
}

/**
 * Build the world for one person.
 *
 * @param {object} bench what `readBenchFolder` returned
 * @param {string} person e.g. "Maya"
 * @param {string} setupRaw the setup file's text, written as the production note
 * @param {{ ai?: object, gatewayFetch: Function }} models where model calls go
 * @param {string | null} [today] the day the world is on, as YYYY-MM-DD; null
 *   keeps the real clock. The clock reads noon UTC that day and runs on from there.
 * @param {object | null} [prepared] what `prepareRun` (warm.mjs) returned: the
 *   world then starts from the warmed snapshot, with a ready search database
 *   per workspace, instead of from cold fixture files.
 */
export async function createWorld(bench, person, setupRaw, models, today = null, prepared = null) {
  if (today !== null) assertIsoDate(today);
  const rows = bench.people.filter((row) => row.person === person);
  const own = rows.find((row) => row.personal);
  if (!own) throw new Error(`${person} has no personal workspace in people.md`);

  // Notes are dated from the pinned day, or from the real clock when there is none.
  const baseMs = today === null ? realNow() : noonUtcMs(today);
  const modified = (ms) => new Date(ms).toISOString();

  // A write a turn makes is stamped on the world's clock, so it reads as just written.
  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  // The website and domain `write_note` `site` answers for (`siteStub.mjs`),
  // read from the buckets placed below.
  let site = null;
  const controlPlane = createControlPlaneStub({ site: (cleared, body) => site.answer(cleared, body) });
  // The listing tools list from the Convex tree, copied here from each S3 bucket.
  controlPlane.serveTreesFrom(null, { s3 });
  // A warmed world answers searches from a copy of the snapshot's database.
  const copies = [];
  const d1 = prepared ? createD1Backend({ open: (id) => prepared.openCopy(id, copies) }) : null;
  // The warmed meaning index, copied: a turn's write-behind lands in this
  // conversation's copy and never in the snapshot or the next conversation.
  const vectorize = prepared?.vectors ? createVectorizeBackend({ seed: prepared.vectors }) : null;
  const restore = [s3.install(), controlPlane.install(), ...(d1 ? [d1.install()] : []), ...(vectorize ? [vectorize.install()] : [])];
  if (today !== null) restore.push(installClock(today));

  // The scripted web a golden task runs on (`sites.mjs`): the browser
  // Worker's stand-in, and the answers to web searches.
  const web = models.sites?.length ? createWeb(models.sites) : null;

  // Model calls are the only traffic that leaves the world, and web searches
  // when the run has a search key and no scripted web: production searches
  // the real web, so a run does too (decided 2026-10-09; until 2026-10-11 the
  // world refused the call, so every search_web in a result had failed).
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) return models.gatewayFetch(url, init);
    if (url.startsWith(BRAVE_SEARCH)) {
      if (web) {
        const results = web.search(new URL(url).searchParams.get("q") ?? "");
        return new Response(JSON.stringify({ web: { results } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (typeof models.searchKey === "string" && models.searchKey) return below(input, init);
    }
    if (url.startsWith(S3_ENDPOINT) || url.startsWith(CONTROL_PLANE_ORIGIN)) return below(input, init);
    if ((d1 || vectorize) && url.startsWith(CLOUDFLARE_API_BASE)) return below(input, init);
    throw new Error("a benchmark turn tried to reach the network outside the model");
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  const ids = placeWorkspaces(bench, { s3, controlPlane, baseMs, search: prepared ? "ready" : null, meaning: vectorize !== null, prepared });

  const nameOf = new Map([...ids].map(([name, id]) => [id, name]));
  site = createBenchSite({
    bucketOf: (id) => (nameOf.has(id) ? s3.bucketFor(`bench-${nameOf.get(id)}`) : null),
    handleOf: (id) => nameOf.get(id) ?? null,
  });

  controlPlane.addWorkspace("ws_pinned", PINNED, binding("bench-pinned", 999), { kind: "shared" });
  const pinned = s3.bucketFor("bench-pinned");
  pinned.set("privacy.md", { body: manifest({ shared: true, files: [PRODUCTION_TEXTING_PATH] }), etag: "p0", lastModified: modified(baseMs) });
  pinned.set(PRODUCTION_TEXTING_PATH, { body: setupRaw, etag: "s0", lastModified: modified(noteModifiedAt(setupRaw, baseMs)) });
  // The setup's task skills (`src/agent/skills.js`), where production keeps them.
  for (const [i, skill] of (models.skills ?? []).entries()) {
    pinned.set(skillPath(skill.name), { body: skill.raw, etag: `k${i}`, lastModified: modified(baseMs) });
  }

  const token = `cat_bench_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(own.workspace),
    role: "owner",
    userId: `user_bench_${own.workspace}`,
    accessToken: token,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_texts",
    alsoMemberOf: [
      ...rows.filter((row) => !row.personal).map((row) => ({ workspaceId: ids.get(row.workspace), role: row.role })),
      { workspaceId: "ws_pinned", role: "member" },
    ],
  });

  const before = new Map([...ids].map(([name]) => [name, snapshot(s3.bucketFor(`bench-${name}`))]));
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    // Where the person's own pages live, as in production: a handoff texts
    // `<APP_ORIGIN>/tex/<handle>` (`http/texComputer.js`), and without one
    // the browser cannot be handed over at all.
    APP_ORIGIN: "https://app.bench.invalid",
    // The deployed Worker's search budget (wrangler.toml). The free-tier default
    // of 40 is spent by one bucket scan, and every read, listing and orient in the
    // same turn then fails: the 2026-10-08 results measured exactly that.
    SEARCH_SUBREQUEST_BUDGET: "600",
    ...(DEPLOYED_EGRESS_APPROVALS === undefined ? {} : { EGRESS_APPROVALS: DEPLOYED_EGRESS_APPROVALS }),
    ...(models.ai ? { AI: models.ai } : {}),
    AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_ID: "bench",
    AI_GATEWAY_TOKEN: "bench-gateway-token-not-a-real-one",
    // Production offers search_web and open_page when it has a search key, so
    // a run offers the same tools (decided 2026-10-09; round two measured a
    // shorter tool list than production). The run command passes the key.
    ...(typeof models.searchKey === "string" && models.searchKey ? { BRAVE_SEARCH_API_KEY: models.searchKey } : {}),
    // A scripted web answers searches itself, so no real key is needed or sent.
    ...(web ? { BRAVE_SEARCH_API_KEY: "bench-scripted-search", SITE_SHOTS: web.binding } : {}),
    // The deployment's search settings (`src/search/settings.js`): what a
    // search setup under test puts in the Worker's vars.
    ...(models.searchSettings ? { SEARCH_SETTINGS: JSON.stringify(wireSearchSettings(models.searchSettings)) } : {}),
  };

  /** Files the gateway writes for itself on a save, and Tex's own transcript of the turn: never the model's change. */
  const PLUMBING_FILES = new Set(["privacy.md", "activity.md"]);
  const isPlumbingPath = (path) => path.startsWith(".") || PLUMBING_FILES.has(path) || path.startsWith(`${TRANSCRIPTS_FOLDER}/`);

  const routerSaid = (entry) =>
    typeof entry.confidence !== "number" ? "" : entry.tier === "think" ? ` (${entry.confidence.toFixed(2)})` : ` (think ${entry.confidence.toFixed(2)})`;
  /** The status the failed round got, from the turn log's trace; null when none. */
  const failedStatus = (trace) => {
    const failed = (trace ?? []).find((entry) => entry.kind === "model" && entry.ok === false);
    return typeof failed?.status === "number" ? failed.status : null;
  };

  return {
    /** One texted message, answered with the conversation so far. */
    async text(message) {
      // The person opened the last handoff's link and signed in before texting.
      web?.personSignsIn();
      const { ctx, settle } = createWorkerCtx();
      // The real clock, not the world's: a turn's recorded time is how long it took.
      const started = realNow();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/agent", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ question: message, conversation: "texts" }),
        }),
        env,
        ctx,
      );
      const ms = realNow() - started;
      const body = await response.json().catch(() => null);
      await settle();
      const turn = controlPlane.turnReports.at(-1) ?? {};
      const usage = controlPlane.builtinReports.at(-1) ?? {};
      return {
        ok: response.status === 200 && typeof body?.answer === "string",
        answer: body?.answer ?? "",
        // Held calls the answer asks a YES for (`route.js`); the played person answers.
        asked: typeof body?.asked === "number" ? body.asked : 0,
        // The gateway hides a provider's reason from the caller; the turn log
        // keeps the status (`turnLog.js` `wireTraceEntry`), and a result says it.
        error:
          response.status === 200
            ? null
            : `${String(body?.error ?? `status ${response.status}`)}${failedStatus(turn.trace) === null ? "" : ` (status ${failedStatus(turn.trace)})`}`,
        ms,
        model: usage.model ?? body?.model ?? null,
        // Each call with whether it succeeded: a result note that hides failed calls
        // reads like a model that could not find anything.
        // The router's pick first, when the setup has one (`src/agent/router.js`):
        // a judge sees which tier answered, and the score prices that model.
        // A fallback and a retried round are recorded the same way, because
        // they are what production does and a result must show how often.
        tools: (turn.trace ?? [])
          .filter((entry) => entry.kind === "tool" || entry.kind === "router" || entry.kind === "fallback" || (entry.kind === "model" && (entry.retried || entry.cut)))
          .map((entry) =>
            entry.kind === "router"
              ? // `router: think (0.8)`; a think pick under the setup's cutoff is
                // `router: main (think 0.4)`, so a result shows the near misses.
                { tool: `router: ${entry.tier}${routerSaid(entry)}`, ok: true }
              : entry.kind === "fallback"
                ? { tool: `fallback: ${entry.model}${entry.status === undefined ? "" : ` after ${entry.status}`}`, ok: true }
                : entry.kind === "model" && entry.cut && !entry.retried
                  ? { tool: "cut off at the output cap", ok: true }
                  : entry.kind === "model"
                  ? { tool: `retried${entry.status === undefined ? "" : ` after ${entry.status}`}`, ok: true }
                  : entry.held
                    ? // Held by the egress gate for the person's yes, and run when they
                      // gave it (the played person answers YES): not a failed call.
                      { tool: `${entry.tool} (held for OK)`, ok: true }
                    : { tool: entry.tool, ok: entry.ok !== false },
          ),
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
        },
      };
    },

    /** What the scripted browser did this conversation (`sites.mjs`); empty without one. */
    browser() {
      return [...(web ? web.events() : []), ...site.events()];
    },

    /** What the conversation changed in the invented workspaces, as a list. */
    changes() {
      const out = [];
      for (const [name, was] of before) {
        const now = snapshot(s3.bucketFor(`bench-${name}`));
        for (const [path, text] of now) {
          if (was.get(path) === text) continue;
          if (path.startsWith(PROPOSAL_PENDING_PREFIX)) {
            // A proposal is what the person would be asked to accept.
            let proposal = null;
            try {
              proposal = JSON.parse(text);
            } catch {
              proposal = null;
            }
            out.push({
              workspace: name,
              path: String(proposal?.intended_path ?? "unreadable proposal"),
              kind: "proposed",
              detail: `${String(proposal?.reason ?? "").slice(0, 200)} | ${String(proposal?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400)}`,
            });
            continue;
          }
          // Plumbing a turn writes for itself (history, reads, audit, and the
          // privacy manifest and activity log the gateway rewrites on every
          // save) is not something it did. Round two failed six change questions
          // for every setup on "changed another note", every one `privacy.md`.
          if (isPlumbingPath(path)) continue;
          out.push({ workspace: name, path, kind: "written", detail: text.replace(/\s+/g, " ").trim().slice(0, 300) });
        }
        for (const path of was.keys()) {
          if (!now.has(path) && !isPlumbingPath(path)) out.push({ workspace: name, path, kind: "deleted", detail: "" });
        }
      }
      return out;
    },

    /**
     * One `search_notes` as the person, through the MCP endpoint, the way an
     * AI client calls it: for the search benchmark (`search.mjs`). `context`
     * addresses another workspace, as a client would with `context: "@name"`.
     */
    async search(query, context = null) {
      const { ctx, settle } = createWorkerCtx();
      const started = realNow();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "search_notes", arguments: { query, ...(context ? { context } : {}) } },
          }),
        }),
        env,
        ctx,
      );
      await settle();
      const ms = realNow() - started;
      const body = await response.json().catch(() => null);
      const text = (body?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
      return { ok: response.status === 200 && body?.result?.isError !== true, text, ms };
    },

    close() {
      for (const undo of restore.reverse()) undo();
      d1?.close();
      for (const file of copies) rmSync(file, { force: true });
    },
  };
}
