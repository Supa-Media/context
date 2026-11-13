/**
 * The Run view's text, ported from the artifact's `promptText` and
 * `parseReport`: the prompt a Claude Code session gets (character for
 * character, except that steps 2-4 name the bench's `pnpm ai lab` run from
 * docs/testing/examiner.md), and the reader for a pasted "## Tex replay" report.
 */
import { EXAMINABLE } from "../../data/areas";
import type { config } from "../../engine/diff";
import type { RunResult } from "../../types";

export type AreaScore = { practice: [number, number]; held: [number, number]; usd: number };

export type ParsedResult = RunResult & {
  pass?: boolean;
  headline?: string;
  regressed?: number | null;
  link?: string;
  by?: string | null;
  areas: Record<string, AreaScore>;
};

export function promptText(c: ReturnType<typeof config>): string {
  const pipe = c.areas.includes("pipeline"),
    ex = c.areas.filter((a) => EXAMINABLE.has(a) && a !== "pipeline"),
    no = c.areas.filter((a) => !EXAMINABLE.has(a)),
    swaps = c.changes.filter((x) => x.what === "model");
  return `Tex lab run for version "${c.version.name}" (from ${c.version.base}). Use the repo Supa-Media/context. Spend no API credits.

1. Make a branch from main named lab/${(c.version.name || "version").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)} and build these changes (do not open or merge a pull request):
${c.changes.length ? c.changes.map((x) => `   - ${x.step}: ${x.what}${x.from !== undefined ? ` ${JSON.stringify(x.from)} →` : ""} ${typeof x.to === "string" ? x.to : JSON.stringify(x.to)}${x.how === "setup" ? " (a setup field: put it in the bench's copy of the setup, never in @context-lc ai/production)" : x.how === "fixture" ? " (the test person's own note or chat: change the bench fixture, never a real person's store)" : ""}`).join("\n") : "   - nothing (a baseline run)"}
${Object.keys(c.modules).length ? `   Wording and order are exact. Apply each changed module's text byte for byte (config "modules"; fingerprint is FNV-1a 32-bit of the text). Where a module has a mainFingerprint, first check main's file still has it, and stop and say so if it doesn't. A prompt note's order is the setup's modules: list, in the bench's copy only.\n` : ""}${c.caseEdits.length ? `   Case edits and new cases go in the area's case file on the branch:\n${c.caseEdits.map((e) => `   - ${e.area}/${e.id}${e.isNew ? " (new)" : ""}: ask "${e.ask}", expect "${e.expect}"`).join("\n")}\n` : ""}
${pipe ? "   Then run the pipeline replays, which need no model: `pnpm test` in apps/mcp (test/replay.test.mjs). Report each case as passed or failed.\n" : ""}2. Save the config below as lab.json at the repo root and run it the examiner way, following docs/testing/examiner.md ("A Tex Architecture Lab version"): \`pnpm ai lab plan --config lab.json\`, then \`pnpm ai lab apply --config lab.json\`, then \`BENCH_MODEL_SOCKET_KINDS=claude,workers-ai pnpm ai lab run --config lab.json --base <main sha> --socket <dir> --held-out <dir> --scratch <dir>\`, on these areas: ${ex.join(", ") || "(none examinable)"}.${Object.keys(c.cases).length ? `\n   Only these cases: ${Object.entries(c.cases).map(([a, ids]) => a + ": " + ids.join(", ")).join("; ")}.` : ""}
   A separate agent that never saw the change answers every \`pnpm ai socket next\` call blind. Steps on an API model (Clef, GLM) are called for real through Context (\`manage\` action \`run_model\` with the call's model and input), never with a key in a note.
${no.length ? `   Not examinable here: ${no.join(", ")} (needs API credits). Say so; don't run it.\n` : ""}${swaps.length ? `   Model swaps (${swaps.map((x) => x.step + " → " + x.to).join(", ")}): the examiner answers as the named model, so this shows wiring and prompts, not that model's real quality.\n` : ""}
3. Every model call is logged as one JSON line in <scratch>/lab-steps.jsonl: {"node": "<step id>", "model": "<model>", "ms": <wall ms>, "in": <input tokens>, "out": <output tokens>, "thinking": "<its thinking>", "steps": [<tool calls>], "output": "<what it said>", "side": "branch" | "main"}. Step ids: ${c.steps.map((s) => s.id).join(", ")}.

4. Reply with the "## Lab run" block as printed (it holds the "## Tex replay" report), the run link, and the step log, so I can paste them into the Tex Architecture Lab.

Config (JSON):
${JSON.stringify(c)}`;
}

/** The artifact's reader, with one fix: its `\$([\d.]+)` took the sentence's closing period, so every pasted cost read NaN. */
export function parseReport(txt: string): ParsedResult {
  const r: ParsedResult = { at: Date.now(), areas: {}, raw: txt.slice(0, 6000) };
  const h = txt.match(/Tex replay:\s*(✅|❌)\s*([^\n]*)/);
  if (h) {
    r.pass = h[1] === "✅";
    r.headline = h[2].trim();
  }
  for (const m of txt.matchAll(/\*\*([a-z-]+):\*\*\s*practice (\d+)\/(\d+) right, held-out (\d+)\/(\d+) right; spent about \$(\d+(?:\.\d+)?)/g))
    r.areas[m[1]] = { practice: [+m[2], +m[3]], held: [+m[4], +m[5]], usd: +m[6] };
  const reg = txt.match(/(\d+) case\(s\) regressed/);
  r.regressed = reg ? +reg[1] : r.pass ? 0 : null;
  return r;
}
