/**
 * A STEP'S OWN CASES (Dev2, 2026-11-15: "a lot of nodes don't even have test cases listed here. And there's not a way
 * to add them"). Each file `bench/nodes/<step id>.json` holds one step's cases, written in the Tex Architecture Lab
 * from the step's input and output shapes (`texConfig.json` `inSchema` / `outSchema`):
 *
 *   { "node": "egress", "cases": [{ "id": "asked-to-email", "given": { "words": "...", "action": "send_email" },
 *     "want": { "allow": { "is": "Yes" }, "reason": { "judge": "mentions they asked for it" } } }] }
 *
 * `pnpm ai nodes [--only egress,card] [--fake]` runs each case through the step's own code (`GATEWAY_NODES`) alone:
 * its helpers and wires are not there, so a step that needs its turn says so instead of passing. An exact want
 * compares the output field (yes/no, a choice, a number, words); a judge want asks Haiku through the AI gateway
 * whether the field does what the words say. At most 20 cases a step, as every step (`gateSample.mjs` UNIT_LIMIT).
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { aiGatewayConfig, requestViaGateway } from "../src/agent/aiGateway.js";
import { UNIT_LIMIT } from "./gateSample.mjs";
import { DEFAULT_JUDGE } from "./judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NODES_DIR = join(HERE, "nodes");
const ID = /^[A-Za-z0-9_-]{1,60}$/;

/** Every step's cases, by file; a missing folder is no cases. */
export async function loadNodeCases(dir = NODES_DIR) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const set = JSON.parse(await readFile(join(dir, f), "utf8"));
    if (!ID.test(String(set.node)) || f !== `${set.node}.json`) throw new Error(`${f}: "node" must be the step id the file is named for`);
    if (!Array.isArray(set.cases)) throw new Error(`${f}: "cases" must be a list`);
    if (set.cases.length > UNIT_LIMIT) throw new Error(`${f}: a step keeps at most ${UNIT_LIMIT} cases, this has ${set.cases.length}`);
    for (const c of set.cases) {
      if (!ID.test(String(c.id))) throw new Error(`${f}: case id "${c.id}" is not an id`);
      if (typeof c.given !== "object" || c.given === null || typeof c.want !== "object" || c.want === null) throw new Error(`${f}/${c.id}: "given" and "want" must be objects`);
    }
    out.push({ node: set.node, about: set.about ?? "", cases: set.cases });
  }
  return out;
}

/** A given box's text as the step takes it: JSON for lists, objects, numbers and yes/no, words as they are. */
export function givenValue(text, type) {
  const t = String(text ?? "");
  if (t === "") return undefined;
  if (type === "yesno") return /^(y|yes|true)$/i.test(t.trim());
  if (type === "number") return Number(t);
  if (type === "list" || type === "object") {
    try {
      return JSON.parse(t);
    } catch {
      return type === "list" ? t.split(",").map((s) => s.trim()) : t;
    }
  }
  return t;
}

/** The step's input from a case, typed by the step's `inSchema`. */
export function inputOf(c, inSchema = []) {
  const types = Object.fromEntries((inSchema ?? []).map((f) => [f.name, f.type]));
  const out = {};
  for (const [k, v] of Object.entries(c.given)) {
    const value = givenValue(v, types[k] ?? "text");
    if (value !== undefined) out[k] = value;
  }
  return out;
}

/** Whether an output value is the exact want: yes/no as booleans, choices and words case-blind, numbers by value. */
export function isWanted(value, want) {
  const w = String(want).trim().toLowerCase();
  if (typeof value === "boolean") return (w === "yes" || w === "true") === value;
  if (typeof value === "number") return Number(w) === value;
  if (value === null || value === undefined) return w === "" || w === "none";
  return String(typeof value === "string" ? value : JSON.stringify(value)).trim().toLowerCase() === w;
}

/** Haiku, through the AI gateway, reads one output field against the case's words: yes or no. */
async function judgeField(config, field, value, words) {
  const reply = await requestViaGateway(
    {
      model: DEFAULT_JUDGE,
      system: "You check one output field of a step in a texting assistant against what a test case wants. Answer with yes or no on the first line, then one short reason.",
      messages: [{ role: "user", content: `The field "${field}" came out as:\n<value>${typeof value === "string" ? value : JSON.stringify(value)}</value>\nThe case wants: ${words}\nDoes it?` }],
      maxTokens: 120,
    },
    config,
    { metadata: { feature: "bench", client: "node-cases" } },
  );
  const text = String(reply?.text ?? "").trim();
  return { right: /^yes\b/i.test(text), why: text.split("\n").slice(1).join(" ").trim() || text };
}

/** One case through the step's code alone, then each want checked. */
export async function runCase(fn, c, { inSchema = [], env = {}, judge = null } = {}) {
  const missing = (what) => new Proxy({}, { get: (_target, name) => async () => { throw new Error(`needs its ${what} "${String(name)}", which runs only inside a turn`); } });
  const io = { ctx: { env }, use: missing("helper"), back: missing("send-back"), job: missing("job") };
  let output;
  try {
    output = await fn(inputOf(c, inSchema), io);
  } catch (error) {
    return { id: c.id, right: false, ran: false, why: `can't run alone: ${error instanceof Error ? error.message : String(error)}` };
  }
  const misses = [];
  for (const [field, want] of Object.entries(c.want)) {
    const value = output?.[field];
    if (want?.is !== undefined && want.is !== "") {
      if (!isWanted(value, want.is)) misses.push(`${field} is ${JSON.stringify(value)}, wanted ${want.is}`);
    } else if (want?.judge) {
      if (!judge) misses.push(`${field}: no judge to read "${want.judge}" (no AI gateway)`);
      else {
        const verdict = await judge(field, value, want.judge);
        if (!verdict.right) misses.push(`${field}: ${verdict.why}`);
      }
    }
  }
  return { id: c.id, right: misses.length === 0, ran: true, why: misses.join("; "), output };
}

/** `pnpm ai nodes`: every step's own cases, one line a case. */
export async function nodesCommand(options, { write = (text) => process.stdout.write(text), nodes = null, config = null } = {}) {
  const only = options.only ? new Set(String(options.only).split(",")) : null;
  const sets = (await loadNodeCases(options.dir ?? NODES_DIR)).filter((s) => !only || only.has(s.node));
  const table = nodes ?? (await import("../src/agent/graph/gatewayNodes.js")).GATEWAY_NODES;
  const shapes = config ?? JSON.parse(await readFile(join(HERE, "../../../packages/shared/src/texConfig.json"), "utf8"));
  const gateway = options.fake ? null : aiGatewayConfig(process.env);
  const judge = gateway ? (field, value, words) => judgeField(gateway, field, value, words) : null;
  const rows = [];
  for (const set of sets) {
    const fn = table[set.node];
    const shape = shapes.nodes.find((n) => n.id === set.node);
    for (const c of set.cases) {
      const row = typeof fn !== "function" ? { id: c.id, right: false, ran: false, why: `no step "${set.node}" in the gateway's nodes` } : await runCase(fn, c, { inSchema: shape?.inSchema, env: options.fake ? {} : process.env, judge });
      rows.push({ node: set.node, ...row, id: `${set.node}/${c.id}` });
      write(`${row.right ? "ok  " : "MISS"} ${set.node}/${c.id}${row.why ? `: ${row.why}` : ""}\n`);
    }
  }
  const right = rows.filter((r) => r.right).length;
  write(`\n${right}/${rows.length} right${rows.some((r) => !r.ran) ? `; ${rows.filter((r) => !r.ran).length} could not run alone` : ""}\n`);
  return rows;
}
