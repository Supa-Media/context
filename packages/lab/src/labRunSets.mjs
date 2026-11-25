/**
 * WHICH CONVERSATIONS A LAB RUN COVERS, AND ITS UNITS (moved out of `scripts/tex-lab-run.mjs` so the GitHub run and the
 * Lab sandbox's bench run pick the same conversations with the same code; plan `products/tex/research/
 * sandbox-bench-scoring-2026-11-19.md`, Seyi 2026-11-19: "I don't see why we shouldnt be able to run full tests in
 * sandboxes"). Dependency-free beyond the sets' own contract, so the gateway (a Worker) imports it as the script does.
 */
import { unitTests } from "../../tex/src/texSets.cjs";

/** The Dev conversations a run covers: the repo's with the Lab's drafts over them, one chat when the run names one. */
export function devConversations(repo, drafts, convId = null) {
  const byId = new Map(repo.filter((c) => c.set === "dev").map((c) => [c.id, c]));
  for (const d of drafts ?? []) {
    if (d.set !== "dev" || d.removed) {
      byId.delete(d.id);
      continue;
    }
    let conv = null;
    try {
      conv = typeof d.conv === "string" ? JSON.parse(d.conv) : d.conv;
    } catch {
      conv = null;
    }
    if (conv && Array.isArray(conv.msgs)) byId.set(d.id, { ...conv, id: d.id, set: "dev" });
  }
  const all = [...byId.values()];
  if (convId === null) return all;
  return all.filter((c) => c.id === convId);
}

/**
 * The Training conversations a Training run covers: the repo's, less any the Lab moved to Dev or removed (Dev2,
 * 2026-11-18: "prove it on Training ... a scored Lab Training run"). The Lab's Training drafts carry only their id and
 * set, so a conversation edited in the Lab runs as the repo has it until its Promote.
 */
export function trainingConversations(repo, drafts, convId = null) {
  const gone = new Set((drafts ?? []).filter((d) => d.set !== "training" || d.removed).map((d) => d.id));
  const all = repo.filter((c) => c.set === "training" && !gone.has(c.id));
  return convId === null ? all : all.filter((c) => c.id === convId);
}

/** A run's conversations by its set: "training" or "dev" (the default). */
export function runConversations(set, repo, drafts, convId = null) {
  return set === "training" ? trainingConversations(repo, drafts, convId) : devConversations(repo, drafts, convId);
}

/**
 * The units a sandbox bench run walks: each Front door unit test (`texSets.cjs` `unitTests`, node "fd") once per
 * repeat, in the order the GitHub runner makes them (`apps/mcp/bench/setsRun.mjs` `runSets`: conversation by
 * conversation, a test's repeats together). `i` is the unit's place; `rep` its repeat (0-based), as a runner row's.
 * Only the Front door: the sandbox runs whole turns, and the other steps' unit tests run alone on GitHub.
 */
export function benchUnits(convs, repeats = 1) {
  const n = Number.isInteger(repeats) && repeats >= 1 && repeats <= 5 ? repeats : 1;
  const units = [];
  for (const c of convs) {
    for (const t of unitTests(c)) {
      if (t.node !== "fd") continue;
      for (let rep = 0; rep < n; rep++) units.push({ i: units.length, chat: c.id, msg: t.msg, at: t.at, node: "fd", rep });
    }
  }
  return units;
}

/**
 * Why a unit's message is not texted words, or null when it is: the Lab sandbox's bench runs texted words only (a
 * trigger, a tapback or edit, or pictures is a row that could not run there; the GitHub run's bench plays each).
 * Shared by the gateway's bench turn (`labSandbox/benchTurn.js`) and the parity estimate (`scripts/tex-lab-parity.mjs`).
 */
export function notWords(m) {
  if (!m || typeof m.text !== "string") return "no such message";
  if (m.via !== undefined && m.via !== null) return `a ${m.via} trigger`;
  // A quoted reply is texted words too: the test chat sends it as a reply to the row it quotes.
  if (m.kind !== undefined && m.kind !== null && m.kind !== "reply") return `a ${m.kind}`;
  if (Array.isArray(m.pics) && m.pics.length > 0) return "pictures";
  if (m.text.trim() === "") return "no words";
  return null;
}
