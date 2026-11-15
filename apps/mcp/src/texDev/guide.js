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
  ["get", "{ draft }", "the draft's whole graph, its revision, how it differs from main (steps, wires, modules' words and conversation settings), and its Run tab (picks, areas, kept results); { draft: \"main\", limit?, full? } answers main's kept results"],
  ["edit", "{ draft, rev, ops: [...] }", "small edits against the revision you last saw (see Edits); answers the new revision, what changed, the checks and anything the other side changed meanwhile"],
  ["changes", "{ draft, since, wait? }", "what anyone else changed after revision `since`, each line whole; `wait` (seconds, at most 50) holds the call until the next change"],
  ["rename", "{ draft, name }", "the draft's name, as the Lab's version name field"],
  ["delete", "{ draft, confirm: true }", "the Lab's Delete: the draft, its kept results and its change list, for everyone; permanent, so it needs confirm"],
  ["run_setup", "{ draft, picks?: { <area>: [case ids] | null }, areas?: [areas] | null }", "the Run tab's setup: the cases ticked per area (merged by area; null ticks every case again) and the areas the run covers (null: the ones the changes touch)"],
  ["keep_results", "{ draft | \"main\", report, link? }", "Run's \"Keep these results\": a pasted run report read with the Lab's own reader and kept with the draft, or with main; its \"## Lab replay\" part (the person's own chat) is never kept"],
  ["revert", "{ draft, rev } | { draft, to }", "undo as a new revision: rev undoes the change made at that revision (refused when a later change touched the same thing); to undoes every change after that revision. Kept results stay"],
  ["snapshot", "{ draft? | graph?, focus?, theme?, test? | text? }", "a PNG of the draft as the Lab draws it, or of a graph you pass; `focus` a step or group id; changes from main are marked; with `test` (a key from sim) or `text` each step shows its time and the stats chip its reply time, calls and cost, as the canvas does"],
  ["link", "{ draft } | { mode: \"replay\", chat?, moment? } | { page, draft? }", "the Lab address with this draft open, live; or Replay at a chat and a moment, or one of the Lab's pages (staff sign-in)"],
  ["check", "{ draft | graph }", "the runner's and Promote's checks, without promoting"],
  ["promote", "{ draft }", "the Lab's Promote: a pull request within 15 minutes that merges only through CI and the replay gate"],
  ["tool_stats", "{ days? }", "the Lab's Tools tab: how often each tool ran, failed and how long it took, over 1 to 30 days"],
  ["cases", "{}", "the Lab's shared edits to the bench cases, and its new cases"],
  ["test_set", "{}", "the Test Set as an agent may see it: its counts (chats, unit tests by step, each hidden chat's stars) and the gate's recent runs (pull request, commit, pass or fail, right on the change and on main by step); never a word, a title or an id, because the Test Set is people only (the Lab's Testing tab, Show Test chats)"],
  ["case", "{ key: \"<area>/<case id>\" (a step's own: \"node:<step>/<case id>\"), data: {...} | null, swap_out? }", "keep a case edit or a new case for every staff member, or drop it with null; a step keeps at most 20, so a new case into a full one names the case it trades out (swap_out), as the Tests page's swap"],
  ["chats", "{}", "the chats whose turns you can probe: your one-to-one with Tex and each group chat you are in"],
  ["turns", "{ chat?, day?, before?, limit? }", "a chat's recent replies, 20 unless `limit` (at most 100), with each turn's id, time and how long it took; `day` YYYY-MM-DD, `before` to page back"],
  ["moments", "{ chat?, before?, limit?, moment?, at? }", "Replay's conversation: every moment (a text someone sent, a check-in, a routine, a ping, a quiet look) newest first, 20 unless `limit`, with the texts that came in behind, its turns (waited, ran, which Tex, what it said), the judge's calls, its jobs and time to the last send; `moment` gives one whole: its lines, the timeline's lanes and its rows by step"],
  ["turn", "{ chat?, turn | moment, at?, node?, full? }", "one turn as Replay plays it: the moment's judgings and tapbacks with it, each step's real time and calls, what every step got and gave (`node` for one step's whole), the jobs it started, the notes it read, and every entry in order; the reply's timing once, in brief unless `full`"],
  ["prompt", "{ chat?, turn | moment, round?, node?, module?, from?, limit? }", "the prompt a turn ran on: each round's context modules with size and fingerprint, and their exact words from the prompt catalogue at the turn's commit; modules whose words are not in it are named, never guessed; `module` pages one module's words"],
  ["jobs", "{ chat?, job | turn | moment, from?, limit?, full? }", "a background job's runs as Replay shows them: each run's time, the job check's verdict and advice, its tool calls with what went in and came back, its thinking and what it said; the newest 10 runs unless `from`/`limit`"],
  ["mine", "{ chat?, before?, limit?, q?, pick? }", "the Lab's Your texts: your texts newest first with the chat before each, what Tex said then, which Tex that was and the notes its turn read; `pick` (text ids) answers the run config's replays"],
  ["entries", "{ chat?, kinds?, day?, after?, before?, job? }", "the chat's history file raw, as the Lab and the Tex page read it, 100 entries at a time"],
  ["sim", '{ draft?: <draft id> | "main", test? | text?, from?, base?, log? }', "the Lab's Speed and cost: until the reply, model calls before it, cost and job done after, each against `base` (main by default); where the time goes step by step with its parts, what each step reads (tokens, % cached) and writes; no `test` lists the tests; `text` traces a message you type (`from`: text, checkin, routine or notify); `log` is a pasted step log, the Lab's \"Use this log\""],
  ["compare", "{ drafts?: [ids], test? }", "the Lab's Compare: main and each draft (the newest 20, or those named) with its reply time and cost for the test and each area's latest practice and held-out score"],
  ["config", '{ draft?, prompt? }', "the Lab's Run: every change from main with from → to and how it ships, the areas to run (chosen and by default), its warnings and kept results; then, as its own block, the config JSON the Lab's \"Copy config JSON\" gives (lab.json for `pnpm ai lab run --config`); `prompt: true` adds the Lab's prompt"],
  ["bench", "{ draft?, area?, query?, limit?, offset?, full? } | { ws, at? }", "the Lab's Test cases: each area's cases in the run and those that can't test the draft; with `area`, who runs it, its test panel and its cases (picked or not, edited or new, what each expects, why it can't test the draft), 20 at a time; `ws` browses a bench workspace's notes (`at` a note)"],
  ["modules", "{ draft?, key?, full? }", "the Lab's Modules: every context module by where it comes from, edited or new, and the steps that read it; with `key`, its whole words, fingerprints and the word diff against main (`full` keeps unchanged runs whole)"],
  ["steps", "{ draft?, step? }", "the Tests page's steps: each step's cases out of 20 and its own, the steps no case tests yet; with step, its case form (the given and want boxes from its shapes, with choices), the key for a new case and its own cases"],
  ["marks", "{ draft, vs?: \"main\" | \"last\" }", "the canvas's change marks: steps changed (each field from → to, moved), added and removed, wires new and gone, against main or the draft before its last revision"],
  ["put_back", "{ draft, step, vs?: \"main\" | \"last\" }", "the change marks' Put back: one step back to main's (or the last revision's) version, its fields, place and wires; lands as an edit with the conflict check"],
  ["reference", "{ topic?, draft?, log? }", "the Lab's catalogues: tools (what each does, its actions and the steps that call it; `log` a pasted chat record, counted as the Tools tab does), steps (what each logs and writes), ledger, areas, models, wires, sources, convo"],
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
    "2. Look at it (`snapshot`, with a `test` to see its timings), weigh it (`sim`, `compare`), `check` it, and run it on the bench (`config`).",
    "3. `promote` it. Promote opens the pull request that writes the draft into texConfig.json, regenerates docs/architecture/tex.md and the map every Tex agent is told; it merges only through CI and the replay gate. Nothing you do here changes live Tex before that merge.",
    "A draft changes config only. A new kind of step, a prompt's words or a node's code need a pull request in Supa-Media/context: the node code goes in apps/mcp/src/agent/graph/nodes/, words in packages/shared/src/texPrompt/, and the capability list in apps/mcp/src/agent/capabilities.js. Then run node scripts/tex-architecture.mjs. Tex changes add the replay case that proves them (docs/decisions/testing/replay-gate.md).",
    "",
    "## The Lab's other tabs",
    "Every tab's numbers come from the Lab's own code, so what you read here is what the Lab shows. Modules is `modules` (edit with the module edit; a step's reading order is its `ctx` field) and Conversation is `reference` topic convo, steps and ledger (edit with the convo edit). Tools is `tool_stats` and `reference` topic tools. Test cases is `bench` (change one with `case`; `cases` is the raw edits). Speed and cost is `sim`, an estimate from each step's model, effort, rounds and reads (Replay is what really ran: `turn`). Compare is `compare`. Run is `config`: to run a draft, call `config`, save its config JSON block unchanged as lab.json at the repo root, and run it the examiner way (`pnpm ai lab plan --config lab.json`, `apply`, `run`; apps/mcp/bench/lab.mjs, docs/testing/examiner.md); its kept results are `config`'s results and `get`'s.",
    "Run's test picks and areas are `run_setup`, its \"Keep these results\" is `keep_results` (main's kept results with `get` of main).",
    "Replay is `moments` (its chat and its right panel), `turn` (a step picked on its canvas: real time, got and gave), `prompt` (its Prompt) and `jobs` (a background job's runs); worked out by the Lab's own Replay code. Your texts on Tests, as You, is `mine`.",
    "",
    "## Finding out why a turn went the way it did",
    "`chats` → `moments` (or `turns`) → `turn` → `prompt` / `jobs`; `link` with a chat and a moment opens the same place in Replay. A turn shows every step and node in the order it ran with its input, output, thinking, model, milliseconds and whether it failed, every tool call with its arguments and result, the briefs and context it was given, and the slowest steps. Replay shows only what the log shows ran; nothing is estimated (Dev2, 2026-11-14).",
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
