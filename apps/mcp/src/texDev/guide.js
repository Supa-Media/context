/**
 * `tex_dev` action `guide`: how to develop on Tex, for an AI that just connected. Built from Tex's config on every
 * call (`texConfig.json`, the one source of what runs), so the steps, models and wires it names are never stale.
 */

import { MODES } from "../../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG } from "../agent/texConfig.js";

const MODE_MEANING = {
  wait: "the next step: it runs after this one, with its output",
  background: "runs after the reply is sent, never holding the person up",
  uses: "a helper the step may call while it runs (a judge, a tool, a sub-agent)",
  loop: "a send-back: the target may send work back, up to the wire's rounds",
  job: "starts a background job that runs on its own and reports back",
};

/** The actions, in the order a session usually needs them, with what each takes. */
export const ACTIONS = [
  ["guide", "{}", "this guide"],
  ["list", "{}", "every draft: id, name, who made it, revision, which AI is in it now"],
  ["create", '{ name, from?: "main" | <draft id>, graph? }', "a new draft, from main (default), another draft, or a whole graph you pass; answers its id and live link"],
  ["get", "{ draft }", "the draft's whole graph, its revision and how it differs from main (steps, wires, modules' words and conversation settings)"],
  ["edit", "{ draft, rev, ops: [...] }", "small edits against the revision you last saw (see Edits); answers the new revision, what changed, the checks and anything the other side changed meanwhile"],
  ["changes", "{ draft, since, wait? }", "what anyone else changed after revision `since`; `wait` (seconds, at most 50) holds the call until the next change"],
  ["snapshot", "{ draft? | graph?, focus?, theme?, test? | text? }", "a PNG of the draft as the Lab draws it, or of a graph you pass; `focus` a step or group id; changes from main are marked; with `test` (a key from sim) or `text` each step shows its time and the stats chip its reply time, calls and cost, as the canvas does"],
  ["link", "{ draft }", "the Lab address with this draft open, live (staff sign-in)"],
  ["check", "{ draft | graph }", "the runner's and Promote's checks, without promoting"],
  ["promote", "{ draft }", "the Lab's Promote: a pull request within 15 minutes that merges only through CI and the replay gate"],
  ["tool_stats", "{ days? }", "the Lab's Tools tab: how often each tool ran, failed and how long it took, over 1 to 30 days"],
  ["cases", "{}", "the Lab's shared edits to the bench cases, and its new cases"],
  ["case", "{ key: \"<area>/<case id>\", data: {...} | null }", "keep a case edit or a new case for every staff member, or drop it with null"],
  ["chats", "{}", "the chats whose turns you can probe: your one-to-one with Tex and each group chat you are in"],
  ["turns", "{ chat?, day?, before? }", "a chat's recent texts and replies with each turn's id, time and how long it took; `day` YYYY-MM-DD, `before` to page back"],
  ["turn", "{ chat?, turn, full? }", "one turn exactly as it ran: every step and node in order with input, output, thinking, the context it loaded, model, timing, what failed, every tool call, and the slowest steps"],
  ["entries", "{ chat?, kinds?, day?, after?, before?, job? }", "the chat's history file raw, as the Lab and the Tex page read it, 100 entries at a time"],
  ["sim", '{ draft?: <draft id> | "main", test? | text?, from?, base?, log? }', "the Lab's Speed and cost: until the reply, model calls before it, cost and job done after, each against `base` (main by default); where the time goes step by step with its parts, what each step reads (tokens, % cached) and writes; no `test` lists the tests; `text` traces a message you type (`from`: text, checkin, routine or notify); `log` is a pasted step log, the Lab's \"Use this log\""],
  ["compare", "{ drafts?: [ids], test? }", "the Lab's Compare: main and each draft (the newest 20, or those named) with its reply time and cost for the test and each area's latest practice and held-out score"],
  ["config", '{ draft?, prompt? }', "the Lab's Run: every change from main with from → to and how it ships, the areas to run (chosen and by default), its warnings and kept results; then, as its own block, the config JSON the Lab's \"Copy config JSON\" gives (lab.json for `pnpm ai lab run --config`); `prompt: true` adds the Lab's prompt"],
  ["bench", "{ draft?, area?, query?, limit?, offset?, full? } | { ws, at? }", "the Lab's Test cases: each area's cases in the run and those that can't test the draft; with `area`, who runs it, its test panel and its cases (picked or not, edited or new, what each expects, why it can't test the draft), 20 at a time; `ws` browses a bench workspace's notes (`at` a note)"],
  ["modules", "{ draft?, key?, full? }", "the Lab's Modules: every context module by where it comes from, edited or new, and the steps that read it; with `key`, its whole words, fingerprints and the word diff against main (`full` keeps unchanged runs whole)"],
  ["reference", "{ topic?, draft?, log? }", "the Lab's catalogues: tools (what each does, its actions and the steps that call it; `log` a pasted chat record, counted as the Tools tab does), steps (what each logs and writes), ledger, areas, models, wires, sources, convo"],
];

export const EDIT_OPS = [
  '{ op: "set", node, field, value }  one field of one step (null removes it)',
  '{ op: "move", node, x, y }  where it sits on the canvas',
  '{ op: "add", node: { id, ...fields } }  a new step (needs code before it can promote)',
  '{ op: "remove", node }  a step and its wires (main\'s steps are turned off, not removed, to promote)',
  '{ op: "wire", from, to, mode, when? }  a wire; one per from, to and mode',
  '{ op: "unwire", from, to, mode? }  a wire, or every mode between the two',
  '{ op: "module", key, value }  one context module\'s edit (its words as value.text, for a p-<name> prompt module); null drops it',
  '{ op: "convo", field, value }  one conversation setting (word, older, threads, days, dayChars, slim, classify, tools); null drops it',
  '{ op: "put", graph }  the whole graph',
];

/** The guide's text. */
export function guideText(config = TEX_CONFIG) {
  const groups = config.groups ?? {};
  const byGroup = new Map();
  for (const n of config.nodes) {
    const key = n.group ?? "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(n);
  }
  const stepLine = (n) => `  - ${n.id} (${n.label}): ${n.model}${n.effort ? ", effort " + n.effort : ""}${n.on === false ? ", OFF" : ""}${n.timeoutS ? `, ${n.timeoutS} s limit` : ""}${n.file ? ` · code: ${n.file}` : ""}`;
  const steps = [...byGroup.entries()].flatMap(([group, nodes]) => [group ? `- group "${group}" (${groups[group]?.label ?? group}):` : "- steps:", ...nodes.map(stepLine)]);
  const wires = config.edges.map((e) => `  ${e.from} → ${e.to} (${e.mode}${(e.when ?? ["*"]).join(",") === "*" ? "" : ", when " + e.when.join(", ")})`);
  return [
    "# Developing on Tex",
    "",
    "Tex is the texting assistant. Everything that runs in a Tex turn is a step (a node) in one graph, packages/shared/src/texConfig.json, and the wires between steps are config, not code (Dev2, 2026-11-14). A step's code lives in the gateway; its model, effort, on or off, time limit, rounds, the context it reads in order and its wires live in the config. The Tex Architecture Lab (context.lc/lab) opens that config as main.",
    "",
    "## How to change Tex",
    "1. Make a draft (`create`), and edit it (`edit`) while a person watches or edits the same draft in the Lab (`link`). Every answer says what the other side changed; `changes` with `wait` listens for them.",
    "2. Look at it (`snapshot`, with a `test` to see its timings), weigh it (`sim`, `compare`), `check` it, and run it on the bench (`config`).",
    "3. `promote` it. Promote opens the pull request that writes the draft into texConfig.json, regenerates docs/architecture/tex.md and the map every Tex agent is told; it merges only through CI and the replay gate. Nothing you do here changes live Tex before that merge.",
    "A draft changes config only. A new kind of step, a prompt's words or a node's code need a pull request in Supa-Media/context: the node code goes in apps/mcp/src/agent/graph/nodes/, words in packages/shared/src/texPrompt/, and the capability list in apps/mcp/src/agent/capabilities.js. Then run node scripts/tex-architecture.mjs. Tex changes add the replay case that proves them (docs/decisions/testing/replay-gate.md).",
    "",
    "## The Lab's other tabs",
    "Every tab's numbers come from the Lab's own code, so what you read here is what the Lab shows. Modules is `modules` (edit with the module edit; a step's reading order is its `ctx` field) and Conversation is `reference` topic convo, steps and ledger (edit with the convo edit). Tools is `tool_stats` and `reference` topic tools. Test cases is `bench` (change one with `case`; `cases` is the raw edits). Speed and cost is `sim`, an estimate from each step's model, effort, rounds and reads (Replay is what really ran: `turn`). Compare is `compare`. Run is `config`: to run a draft, call `config`, save its config JSON block unchanged as lab.json at the repo root, and run it the examiner way (`pnpm ai lab plan --config lab.json`, `apply`, `run`; apps/mcp/bench/lab.mjs, docs/testing/examiner.md); its kept results are `config`'s results and `get`'s.",
    "",
    "## Finding out why a turn went the way it did",
    "`chats` → `turns` → `turn`. A turn shows every step and node in the order it ran with its input, output, thinking, model, milliseconds and whether it failed, every tool call with its arguments and result, the briefs and context it was given, and the slowest steps. Replay shows only what the log shows ran; nothing is estimated (Dev2, 2026-11-14).",
    "",
    "## Edits",
    ...EDIT_OPS.map((line) => "- " + line),
    "An edit made against an older revision lands unless someone changed the same piece since; then it is refused with what is there now, and you edit again against the new revision.",
    "",
    "## Wire modes",
    ...MODES.map((mode) => `- ${mode}: ${MODE_MEANING[mode] ?? ""}`),
    "A wire's `when` lists the tags (from the source step's output `to`/`when`) it fires on; [\"*\"] is always.",
    "",
    "## Actions",
    ...ACTIONS.map(([name, args, what]) => `- ${name} ${args}: ${what}`),
    "",
    `## Main today (${config.nodes.length} steps, ${config.edges.length} wires)`,
    `Models: ${Object.entries(config.models).map(([k, id]) => `${k} = ${id}`).join("; ")}; code = no model.`,
    ...steps,
    "Wires:",
    ...wires,
  ].join("\n");
}
