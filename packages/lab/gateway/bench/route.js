/**
 * `POST /tex-lab/bench`: the standing bench objects (`store.js`), loaded once and asked many searches at once
 * (Dev2, 2026-11-22: a benchmark run in seconds, every search in parallel). Production's gateway scores main; a pull
 * request's preview gateway (`deploy-preview.yml`) scores that pull request's code, each with its own objects.
 *
 * Who may call: the Lab's eval workflow on main, by GitHub's signed token (`oidc.js`), or a Tex developer by their
 * own grant (the control plane's `texDeveloper` check, as the Lab's test chats ask it). The objects hold public
 * benchmark notes only, never a person's, and a call reaches no other object: every id it names is checked to be a
 * bench id of the world it names (`world.js` `benchIdPrefix`), and every search runs in the bench environment
 * (`env.js`), whose `WORKSPACE_STORE` is `BENCH_STORE`.
 *
 * Ops, each `{op, world, copy, ...}`:
 * - `setup`  a copy's workspaces and people (`setup.js`), from the caller's plan (`objectWorld.mjs` `planOf`)
 * - `notes`  notes put into a copy's workspace, by key (`notes/<id>.md`)
 * - `clone`  a copy's workspace pulls its notes from another copy's, on its own alarm
 * - `build`  a copy's indexes built now for a moment, and on its alarm after
 * - `status` each named workspace's notes and how many changes its indexes still wait on
 * - `search` up to `MAX_CASES` searches, all at once, each through the gateway's MCP endpoint as its person
 * - `drop`   the named workspaces' objects emptied
 */

import { createControlPlane } from "../../../../apps/mcp/src/controlPlane/index.js";
import { sha256Hex } from "../../../../apps/mcp/src/controlPlane/client.js";
import { benchEnvOf, VECTORS_OBJECT, withSettings, WORLDS_PATH } from "./env.js";
import { looksSigned, verifyGithubToken } from "./oidc.js";
import { benchCall, benchToken, searchOnce, setUpPerson, setUpWorkspace } from "./setup.js";
import { MAX_NOTES_PER_CALL } from "./store.js";
import { benchIdPrefix, MAX_COPIES, WORLD_KEY } from "./world.js";
import { workspaceStub } from "../../../../apps/mcp/src/workspaceStore/api.js";

export const BENCH_PATH = "/tex-lab/bench";
/** Most searches one call runs. */
export const MAX_CASES = 50;
/**
 * Longest query. A benchmark asks its questions whole, as an AI client's search_notes would get them (EnterpriseRAG
 * Notes has 35 over 300 characters, the longest 457), so the cap only bounds a call.
 */
export const MAX_QUERY = 2_000;
/** Largest call body: a page of notes. */
const MAX_BODY = 8_000_000;
const NOTE_KEY = /^notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;

const json = (value, status = 200) => Response.json(value, { status });
const refused = (status, error) => json({ error }, status);

/** A Tex developer's grant, asked of the control plane once a minute per isolate. */
const developers = new Map();
async function isDeveloper(env, token) {
  const key = await sha256Hex(token);
  const known = developers.get(key);
  if (known && Date.now() - known.at < 60_000) return known.yes;
  const who = await createControlPlane(env).labSandbox(token, "who").catch(() => null);
  const yes = who !== null && who.status !== "refused" && typeof who.userId === "string";
  if (who !== null) {
    if (developers.size > 1_000) developers.clear();
    developers.set(key, { at: Date.now(), yes });
  }
  return yes;
}

/** Who may call, or the refusal to answer. */
async function admitted(request, env, verify) {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
  if (!token) return refused(401, "sign in");
  if (looksSigned(token)) {
    const checked = await verify(token);
    return checked.claims ? null : refused(403, checked.refused);
  }
  return (await isDeveloper(env, token)) ? null : refused(403, "Only Tex developers and the Lab's eval workflow use the bench.");
}

/**
 * A run's use of `world` noted (with ids it set up), and every world idle a week dropped: a world's copies hold
 * hundreds of megabytes each, and a change to the index code leaves the old world unread.
 */
async function touch(bench, ctx, world, ids = []) {
  const registry = bench.BENCH_STORE.get(bench.BENCH_STORE.idFromName(VECTORS_OBJECT));
  const { idle = [] } = await (await registry.fetch(new Request(`https://bench.internal${WORLDS_PATH}`, { method: "POST", body: JSON.stringify({ touch: { world, ids } }) }))).json();
  const drop = Promise.all(idle.flatMap((old) => old.ids.map((id) => benchCall(bench, id, "/bench/drop").catch(() => null))));
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(drop);
  else await drop;
}

/** Every id the call names belongs to this world's copy, or the call is refused. */
const ownId = (world, copy, id) => typeof id === "string" && id.length <= 64 && id.startsWith(benchIdPrefix(world, copy)) && /^[A-Za-z0-9_-]+$/.test(id);

export async function handleBench(request, env, ctx, { gateway, verify = verifyGithubToken } = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env?.BENCH_STORE) return refused(501, "this deployment has no bench objects");
  const refusal = await admitted(request, env, verify);
  if (refusal) return refusal;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return refused(413, "a call is at most 8 MB");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return refused(400, "a call is JSON");
  }
  const { op, world } = input ?? {};
  const copy = Number(input?.copy ?? 0);
  if (typeof op !== "string" || !WORLD_KEY.test(world ?? "") || !Number.isSafeInteger(copy) || copy < 0 || copy >= MAX_COPIES) return refused(400, "a call is { op, world, copy, ... }");
  const bench = benchEnvOf(env);
  const ids = (list) => (Array.isArray(list) && list.length > 0 && list.length <= 100 && list.every((id) => ownId(world, copy, id)) ? list : null);

  if (op === "setup") {
    const workspaces = Array.isArray(input.plan?.workspaces) ? input.plan.workspaces : [];
    const people = Array.isArray(input.plan?.people) ? input.plan.people : [];
    if (!ids(workspaces.map((w) => w.workspaceId)) || !people.every((p) => ownId(world, copy, p.personalWorkspaceId) && (p.reach ?? []).every((r) => ownId(world, copy, r.workspaceId)))) return refused(400, "every id in the plan is this copy's");
    for (const workspace of workspaces) {
      if (!Array.isArray(workspace.files) || !workspace.files.every((path) => typeof path === "string" && path.length <= 1_000)) return refused(400, "files are paths");
      if (!(workspace.members ?? []).every((m) => ownId(world, copy, m.personalWorkspaceId))) return refused(400, "every member's id is this copy's");
      const opens = workspace.opens ?? [];
      if (!Array.isArray(opens) || opens.length > 1_000 || !opens.every((o) => o && typeof o.path === "string" && (o.by === "ai" || (o.by === "person" && typeof o.who === "string")) && Number.isInteger(o.count))) return refused(400, "opens are paths, who and counts");
      await setUpWorkspace(bench, { workspaceId: workspace.workspaceId, name: String(workspace.name), kind: workspace.kind === "shared" ? "shared" : "personal", files: workspace.files, rules: workspace.rules, members: workspace.members ?? [], opens: opens.map(({ path, who, by, count }) => (by === "ai" ? { path, by, count } : { path, who, by, count })) });
    }
    for (const person of people) await setUpPerson(bench, { personalWorkspaceId: person.personalWorkspaceId, userId: String(person.userId), reach: person.reach ?? [] });
    await touch(bench, ctx, world, workspaces.map((w) => w.workspaceId));
    return json({ set: workspaces.length, people: people.length });
  }

  if (op === "notes") {
    if (!ownId(world, copy, input.workspaceId)) return refused(400, "workspaceId is this copy's");
    const notes = Array.isArray(input.notes) ? input.notes : [];
    if (notes.length > MAX_NOTES_PER_CALL || !notes.every((n) => NOTE_KEY.test(n?.key ?? "") && typeof n.text === "string")) return refused(400, `notes are at most ${MAX_NOTES_PER_CALL} { key, text }`);
    const stub = workspaceStub(bench, input.workspaceId);
    for (const note of notes) {
      const response = await stub.fetch(new Request("https://tex-store.internal/put", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: note.key, options: {} })) }, body: note.text }));
      if (response.status !== 200) return refused(502, `the bench object refused ${note.key} (${response.status})`);
    }
    // The copy's alarm builds its indexes from here on (`store.js` `runAlarm`).
    await benchCall(bench, input.workspaceId, "/bench/build", { ms: 0 });
    return json({ put: notes.length });
  }

  if (op === "clone") {
    // The source is the same world's first copy: one copy never reads another world's notes.
    if (!ownId(world, copy, input.workspaceId) || !ownId(world, 0, input.from) || copy === 0) return refused(400, "a copy past the first clones the first copy's workspace");
    return json(await benchCall(bench, input.workspaceId, "/bench/clone", { from: input.from, ...(Number.isSafeInteger(input.page) ? { page: input.page } : {}) }));
  }

  if (op === "build") {
    if (!ownId(world, copy, input.workspaceId)) return refused(400, "workspaceId is this copy's");
    return json(await benchCall(bench, input.workspaceId, "/bench/build", { ms: Math.min(Number(input.ms) || 0, 20_000) }));
  }

  if (op === "status") {
    const list = ids(input.workspaceIds);
    if (!list) return refused(400, "workspaceIds are this copy's");
    const out = {};
    await Promise.all(list.map(async (id) => (out[id] = await benchCall(bench, id, "/bench/status"))));
    if (copy === 0) await touch(bench, ctx, world);
    return json({ workspaces: out });
  }

  if (op === "search") {
    const cases = Array.isArray(input.cases) ? input.cases : [];
    const good = cases.length > 0 && cases.length <= MAX_CASES && cases.every((c) => typeof c?.id === "string" && typeof c.query === "string" && c.query.trim() !== "" && c.query.length <= MAX_QUERY && ownId(world, copy, c.personal) && (c.context === null || c.context === undefined || /^@[A-Za-z0-9_-]{1,64}$/.test(c.context)));
    if (!good) return refused(400, `cases are 1 to ${MAX_CASES} { id, query, personal, context? }`);
    const settings = typeof input.settings === "string" && input.settings.length <= 20_000 ? input.settings : null;
    const env2 = withSettings(bench, settings);
    const answers = await Promise.all(
      cases.map(async (c) => {
        const started = Date.now();
        const token = await benchToken(bench, c.personal);
        const answer = await searchOnce((req, e) => gateway(req, e), env2, token, c.query, c.context ?? null).catch((error) => ({ ok: false, text: String(error?.message ?? error).slice(0, 200), status: 500 }));
        return { id: c.id, ...answer, ms: Date.now() - started };
      }),
    );
    return json({ answers });
  }

  if (op === "drop") {
    const list = ids(input.workspaceIds);
    if (!list) return refused(400, "workspaceIds are this copy's");
    await Promise.all(list.map((id) => benchCall(bench, id, "/bench/drop")));
    return json({ dropped: list.length });
  }

  return refused(400, `unknown op ${op}`);
}
