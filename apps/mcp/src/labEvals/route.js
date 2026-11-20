/**
 * `POST /tex-lab/evals`: THE LAB'S EVALS (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval,
 * and build out the adapter for this eval"; decision `docs/decisions/texting-assistant/lab-evals.md`).
 *
 * Public benchmarks run through real Tex, apart from the Training, Dev and Test sets: nothing here reads or writes
 * those, and nothing here gates CI. One JSON body `{ op, ... }`, the caller's own grant as the bearer (the Lab's
 * console grant, or an AI client's for `tex_dev evals`); only the people the Lab's test chats let in
 * (`texLabSandbox.ts` `who`) get past the first line.
 *
 *  - `benches` → `{ benches: [{ id, title, variant, about, source: { sha, file, count, at } | null }] }`.
 *  - `runs { limit? }` → `{ runs: [{ id, bench, versionId, n, status, by, at, endedAt?, scores }] }`, newest first.
 *  - `start { bench, versionId?, n?, concurrency? }` → `{ run }`: a stratified slice of `n` questions (`sliceOf`; every
 *    question when n is left out), on main or a Lab draft; reads the dataset first when it was never read.
 *  - `advance { runId }` → `{ run, scores, items }`: grades what has answered and starts the next questions (`run.js`).
 *  - `get { runId }` → `{ run, scores, items }`; `item { runId, qid }` → `{ item }` with Tex's whole answer and its test
 *    chat (open it in the Lab, or `tex_dev sandbox` with its sandboxId, to see every step it ran).
 *  - `stop { runId }`: no more questions start; those asked are still graded by the next `advance`.
 *  - `remove { runId }`: the run and its results deleted.
 */

import { bearerToken } from "../session.js";
import { createControlPlane } from "../controlPlane.js";
import { json } from "../http/responses.js";
import { BENCHES, benchOf, sliceOf } from "./longMemEval.js";
import { buildIndex, DatasetError, discover } from "./dataset.js";
import { callEvals, evalsStub } from "./store.js";
import { advance, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, scoresOf } from "./run.js";

export const LAB_EVALS_PATH = "/tex-lab/evals";
const RUN_ID = /^ev[0-9a-z]{10,20}$/;
const VERSION = /^(main|v[0-9a-z]{1,16})$/;

const refused = (status, error) => json({ error }, status);
const runIdOf = () => `ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const byOf = (by) => (typeof by === "string" && /^[\p{L}\p{N} ._()\-]{1,60}$/u.test(by) ? by : "Lab");

/** An item as a list shows it: what was asked and how it went, never its whole answer. */
function itemRow(item) {
  return {
    qid: item.qid,
    type: item.type,
    ability: item.ability,
    state: item.state,
    question: item.question,
    gold: item.gold,
    ...(typeof item.answer === "string" ? { answer: item.answer.length > 300 ? `${item.answer.slice(0, 299)}…` : item.answer } : {}),
    ...(typeof item.correct === "boolean" ? { correct: item.correct } : {}),
    ...(item.sandboxId ? { sandboxId: item.sandboxId } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(item.note ? { note: item.note } : {}),
    ...(Number.isFinite(item.replyMs) ? { replyMs: item.replyMs } : {}),
    usd: Math.round(((item.turnUsd ?? 0) + (item.summaryUsd ?? 0) + (item.judgeUsd ?? 0)) * 10_000) / 10_000,
  };
}

const withScores = (run, items) => ({ run, scores: scoresOf(items), items: items.map(itemRow) });

/** The dataset's file and index, read once per benchmark and kept. */
async function ensureSource(stub, bench, fetchImpl) {
  const kept = (await callEvals(stub, "source", { bench })).source;
  if (kept?.url && kept.count > 0) return kept;
  const found = await discover(bench, fetchImpl);
  const entries = await buildIndex(found.url, fetchImpl);
  const source = { ...found, at: Date.now() };
  await callEvals(stub, "source.put", { bench, source, entries });
  console.log(JSON.stringify({ event: "lab_evals_indexed", bench, questions: entries.length }));
  return { ...source, count: entries.length };
}

export async function handleLabEvals(request, env, ctx, options = {}) {
  try {
    return await serveLabEvals(request, env, ctx, options);
  } catch (error) {
    console.log(JSON.stringify({ event: "lab_evals_failed", reason: String(error?.message ?? error).slice(0, 200) }));
    if (error instanceof DatasetError) return refused(502, error.message);
    return refused(500, "The evals hit a problem on the server and couldn't finish. Try again.");
  }
}

async function serveLabEvals(request, env, ctx, { origin = "https://context.lc", fetchImpl = fetch, requestImpl, now } = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const stub = evalsStub(env);
  if (stub === null || !env?.LAB_SANDBOX) return refused(501, "this deployment has no Lab evals");
  const token = bearerToken(request);
  if (!token) return refused(401, "sign in");
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.op !== "string") return refused(400, "a call is { op, ... }");
  const controlPlane = createControlPlane(env);
  const who = await controlPlane.labSandbox(token, "who").catch(() => null);
  if (who === null) return refused(503, "the control plane did not answer");
  if (who.status === "refused" || typeof who.userId !== "string") return refused(403, "Only Tex developers use the Lab's evals.");

  switch (input.op) {
    case "benches": {
      const benches = [];
      for (const bench of BENCHES) {
        const source = (await callEvals(stub, "source", { bench: bench.id })).source;
        benches.push({ id: bench.id, title: bench.title, variant: bench.variant, about: bench.about, source: source ? { sha: source.sha, file: source.file, count: source.count, at: source.at } : null });
      }
      return json({ benches });
    }
    case "runs": {
      const runs = (await callEvals(stub, "runs", { limit: Number.isSafeInteger(input.limit) ? input.limit : 50 })).runs ?? [];
      const out = [];
      for (const run of runs) {
        const { items } = await callEvals(stub, "run", { id: run.id });
        out.push({ ...run, scores: scoresOf(items ?? []) });
      }
      return json({ runs: out });
    }
    case "start": {
      const bench = benchOf(input.bench ?? "longmemeval-s");
      if (bench === null) return refused(400, `bench is one of ${BENCHES.map((b) => b.id).join(", ")}`);
      const versionId = input.versionId === undefined || input.versionId === null || input.versionId === "" ? "main" : input.versionId;
      if (typeof versionId !== "string" || !VERSION.test(versionId)) return refused(400, "versionId is main or a Lab draft's id");
      if (versionId !== "main") {
        const draft = await controlPlane.labSandbox(token, "draft", { draft: versionId });
        if (draft?.status !== "ok") return refused(404, "There is no such draft: save it in the Lab first.");
      }
      if (input.n !== undefined && (!Number.isSafeInteger(input.n) || input.n < 1 || input.n > 500)) return refused(400, "n is 1 to 500 questions");
      const concurrency = Number.isSafeInteger(input.concurrency) ? Math.max(1, Math.min(input.concurrency, MAX_CONCURRENCY)) : DEFAULT_CONCURRENCY;
      const source = await ensureSource(stub, bench.id, fetchImpl);
      const index = (await callEvals(stub, "index", { bench: bench.id })).entries ?? [];
      const picked = sliceOf(index, input.n ?? index.length);
      const at = (now ?? Date.now)();
      const run = { id: runIdOf(), bench: bench.id, versionId, n: picked.length, status: "running", by: byOf(input.by), byUser: who.userId, at, concurrency, sha: source.sha };
      await callEvals(stub, "run.put", { run });
      const items = picked.map((entry, n) => ({ qid: entry.id, n, type: entry.type, ability: entry.ability, question: entry.question, gold: entry.answer, start: entry.start, end: entry.end, state: "waiting" }));
      for (let from = 0; from < items.length; from += 100) await callEvals(stub, "items.put", { run: run.id, items: items.slice(from, from + 100) });
      console.log(JSON.stringify({ event: "lab_evals_start", bench: bench.id, n: picked.length, draft: versionId !== "main" }));
      return json(withScores(run, items));
    }
    case "get":
    case "advance":
    case "stop":
    case "remove":
    case "item": {
      if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) return refused(400, "name the run: runId");
      const kept = await callEvals(stub, "run", { id: input.runId });
      if (!kept.run) return refused(404, "There is no such eval run.");
      if (input.op === "get") return json(withScores(kept.run, kept.items ?? []));
      if (input.op === "item") {
        const item = (kept.items ?? []).find((i) => i.qid === input.qid);
        return item ? json({ item: { ...item, start: undefined, end: undefined } }) : refused(404, "That question is not in this run.");
      }
      if (input.op === "remove") {
        await callEvals(stub, "run.remove", { id: input.runId });
        return json({ ok: true });
      }
      if (input.op === "stop") {
        const waiting = (kept.items ?? []).filter((i) => i.state === "waiting").map((i) => ({ qid: i.qid, state: "failed", error: "stopped before it started", doneAt: Date.now() }));
        if (waiting.length > 0) await callEvals(stub, "items.put", { run: input.runId, items: waiting });
        const { run } = await callEvals(stub, "run.put", { run: { id: input.runId, status: "stopped", endedAt: Date.now() } });
        const { items } = await callEvals(stub, "run", { id: input.runId });
        return json(withScores(run, items ?? []));
      }
      const { open } = await import("../labSandbox/route.js");
      const { handleLabSandbox } = await import("../labSandbox/route.js");
      const deps = {
        env,
        stub,
        who,
        token,
        origin,
        fetchImpl,
        ...(requestImpl ? { request: requestImpl } : {}),
        ...(now ? { now } : {}),
        open: (body) => open(env, controlPlane, token, who, body, origin),
        sandbox: async (body) => {
          const call = new Request(`${origin}/tex-lab/sandbox`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
          const response = await handleLabSandbox(call, env, ctx, { origin });
          return { ok: response.ok, status: response.status, answer: await response.json().catch(() => ({})) };
        },
      };
      const moved = await advance(deps, input.runId);
      if (moved.error) return refused(...moved.error);
      const items = moved.items ?? (await callEvals(stub, "run", { id: input.runId })).items ?? [];
      return json(withScores(moved.run, items));
    }
    default:
      return refused(400, "op is benches, runs, start, advance, get, item, stop or remove");
  }
}
