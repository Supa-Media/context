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
  ["get", "{ draft }", "the draft's whole graph, its revision, how it differs from main, and its Run tab (picks, areas, kept results); { draft: \"main\", limit?, full? } answers main's kept results"],
  ["edit", "{ draft, rev, ops: [...] }", "small edits against the revision you last saw (see Edits); answers the new revision, what changed, the checks and anything the other side changed meanwhile"],
  ["changes", "{ draft, since, wait? }", "what anyone else changed after revision `since`, each line whole; `wait` (seconds, at most 50) holds the call until the next change"],
  ["rename", "{ draft, name }", "the draft's name, as the Lab's version name field"],
  ["delete", "{ draft, confirm: true }", "the Lab's Delete: the draft, its kept results and its change list, for everyone; permanent, so it needs confirm"],
  ["run_setup", "{ draft, picks?: { <area>: [case ids] | null }, areas?: [areas] | null }", "the Run tab's setup: the cases ticked per area (merged by area; null ticks every case again) and the areas the run covers (null: the ones the changes touch)"],
  ["keep_results", "{ draft | \"main\", report, link? }", "Run's \"Keep these results\": a pasted run report read with the Lab's own reader and kept with the draft, or with main; its \"## Lab replay\" part (the person's own chat) is never kept"],
  ["revert", "{ draft, rev } | { draft, to }", "undo as a new revision: rev undoes the change made at that revision (refused when a later change touched the same thing); to undoes every change after that revision. Kept results stay"],
  ["snapshot", "{ draft? | graph?, focus?, theme? }", "a PNG of the draft as the Lab draws it, or of a graph you pass; `focus` a step or group id; changes from main are marked"],
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
];

export const EDIT_OPS = [
  '{ op: "set", node, field, value }  one field of one step (null removes it)',
  '{ op: "move", node, x, y }  where it sits on the canvas',
  '{ op: "add", node: { id, ...fields } }  a new step (needs code before it can promote)',
  '{ op: "remove", node }  a step, its wires and every read of its output (main\'s steps are turned off, not removed, to promote; text and send always stay)',
  '{ op: "wire", from, to, mode, when? }  a wire; one per from, to and mode',
  '{ op: "unwire", from, to, mode? }  a wire, or every mode between the two',
  '{ op: "module", key, value }  one context module\'s edit (its words as value.text, for a p-<name> prompt module); null drops it',
  '{ op: "convo", field, value }  one conversation setting (word, older, threads, days, dayChars, slim, classify, tools); null drops it',
  '{ op: "convo_tool", tool, on }  one chat tool on or off, merged into the rest (null drops its setting), as the Conversation tab does',
  '{ op: "model", key, value }  one of the draft\'s own models ({ name, full, id, runs: "claude" | "api" | "code", base?, perTok?, cacheR?, cacheW?, outP?, typed?, custom: true }), as the model form keeps it; null deletes it and its steps move to haiku-5-5',
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
    "2. Look at it (`snapshot`), and `check` it.",
    "3. `promote` it. Promote opens the pull request that writes the draft into texConfig.json, regenerates docs/architecture/tex.md and the map every Tex agent is told; it merges only through CI and the replay gate. Nothing you do here changes live Tex before that merge.",
    "A draft changes config only. A new kind of step, a prompt's words or a node's code need a pull request in Supa-Media/context: the node code goes in apps/mcp/src/agent/graph/nodes/, words in packages/shared/src/texPrompt/, and the capability list in apps/mcp/src/agent/capabilities.js. Then run node scripts/tex-architecture.mjs. Tex changes add the replay case that proves them (docs/decisions/testing/replay-gate.md).",
    "",
    "## The Lab's other tabs",
    "Modules and Conversation are the draft's `modules` and `convo` (edit them with the module and convo edits; a step's reading order is its `ctx` field). Tools is `tool_stats`. Tests is `cases` and `case`. Run's test picks and areas are `run_setup`, its \"Keep these results\" is `keep_results` and what is kept is the draft's `results` in `get` (main's with `get` of main); a run itself goes through the bench on a branch (`pnpm ai lab run --config <draft.json>`, apps/mcp/bench/lab.mjs). The Lab's Simulate tab is an estimate drawn in the page; it is not offered here, since it is not what ran.",
    "",
    "## Finding out why a turn went the way it did",
    "`chats` → `turns` → `turn`. A turn shows every step and node in the order it ran with its input, output, thinking, model, milliseconds and whether it failed, every tool call with its arguments and result, the briefs and context it was given, and the slowest steps. Replay shows only what the log shows ran; nothing is estimated (Dev2, 2026-11-14).",
    "",
    "## Edits",
    ...EDIT_OPS.map((line) => "- " + line),
    "An edit made against an older revision lands unless someone changed the same piece since; then it is refused with what is there now, and you edit again against the new revision. Every change, from either side, can be undone with `revert`.",
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
