# Making changes quickly: the Lab, test chats, the bench and previews

This is the guide for changing search, Tex, Tex's quality and the nightly fast. The rule (Dev2, 2026-11-23): **try every change in a sandbox, the fastest one that answers the question, and merge only what won.**

- A config change (a search setting, a Tex step's model or wires, a Training example) is a Lab draft run in a test chat or on the bench, in under a minute.
- A code change goes on a branch with a pull request, which gets its own preview sandbox, redeployed on every push in minutes. Open the pull request as soon as there is something to try, and push and test there as often as you need.
- Merging to main and production is never the test. That round costs about 30 minutes, and a change that loses reaches people before you know it lost.

Everything here works in two places. Signed in at [context.lc/lab](https://context.lc/lab), or from any AI client through the `tex_dev` MCP tool. Whatever the Lab can do, `tex_dev` can do (the Lab parity rule). `tex_dev { action: "guide" }` lists every action and its arguments, and the gateway serves it from this repository's code, so it is always current.

## The ladder: pick the fastest rung that answers your question

| Rung | What it answers | How | Time |
|---|---|---|---|
| 1. One search try-out | How does this one query rank on a draft, next to main? | `tex_dev search { draft, query }`, or the Lab's Search page | about 1 s |
| 2. Search bench on a draft | Does the draft win across a whole benchmark? | `tex_dev search_bench { draft, bench }` | 2 to 10 s |
| 3. Test chat | What does Tex do with this text on a draft, on real models? | `tex_dev test_chat` (open, send, try, again) | seconds per text |
| 4. A pull request's preview sandbox | My change is code. Does it work? | Push to the branch; its preview redeploys. Use the preview's app or texts simulator, or `tex_dev code { draft, code: "#<PR>" }` and `test_chat open { code: "#<PR>" }` for rungs 2 and 3 on it | 5 to 8 min per push |
| 5. Quick Dev run | Does the draft fix its target and break nothing on the steps it changed? | `tex_dev run { draft, quick: true }` | about 5 min on the AI gateway; longer on Claude Code, at $0 |
| 6. GitHub runs | The whole Dev set, a full eval, the examiner | `tex_dev run`, `eval_run` | minutes; 25+ on Claude Code |
| 7. Promote and merge | Land a change that won | `tex_dev promote { draft }` opens the PR, then CI, the gates, merge and production | about 30 min |

Rungs 1 to 3 need no pull request, no GitHub job and no deploy, so a config change stays on them. A code change iterates on rung 4: its pull request's preview is the sandbox for code, and each push is a try. Rung 7 lands what already won; it is never how you try something.

## Changing search

Search runs from its own config, `apps/mcp/src/search/config/searchConfig.json`. It has a step per stage (words, meaning, merge, title, prior, fuse, ...) and each step's settings, bounded by `searchConfig.cjs`. The Lab draws it on the Search page.

### A setting change (most changes)

1. **Draft:** `tex_dev create { name }`, then `edit { draft, rev, ops: [{ op: "set", node: "<step>", field: "settings", value: { ... } }] }`. A step can be turned off with `field: "on", value: false` (except the steps every search needs).
2. **Try one query:** `tex_dev search { draft, query }` shows both rankings and each step's time.
3. **Bench it:** `tex_dev search_bench { draft, bench: "search-hard" }`, then `bench: "enterprise-rag-notes"`. Each runs main and the draft on the standing bench objects and answers:
   - right note first, top 5, found, MRR and p50 for both;
   - every query whose rank moved, worst loss first;
   - the draft's misses with their top three.
4. **Keep what wins:** a draft wins only if it is no worse on every bench, not just the one you were aiming at (`search-hard` and `search-real` are what the gate looks like). Then `tex_dev promote { draft }`. The sealed **Search test set** gate scores it on main before merge.
5. **Check it live:** after production, run a handful of real questions through `search_notes`. The bench is a proxy, and live queries are the final check.

`search_bench { list: true }` names the benches that have saved queries. A bench's queries are saved by its last Lab eval run on main (`tex_dev eval_run { bench, code: "main" }`, once). Re-run that after a change to the index code (`searchIndex.js`, `meaningIndex.js` and the bench object files), because those rebuild the bench worlds.

### A new behaviour (needs code)

New behaviour lands as a setting, so it can be flipped and benched instead of argued about:

1. Add the setting to the step in `searchConfig.cjs` (`SEARCH_SETTINGS_BOUNDS` and `SETTINGS_OF`), with main's value in `searchConfig.json` keeping today's behaviour.
2. Add its label in `packages/lab/app/data/searchSettings.ts`.
3. Plumb it as an option, never as state on the store: the Lab runs main and a draft at once on one store.
4. Add a test for each value, sabotage it, and run `node scripts/tex-architecture.mjs`, which regenerates `docs/architecture/search.md`.
5. Merge it with main's value unchanged. Then flip it in a draft and bench it (rungs 1 and 2). Example: `words.contentWords` (#4039). With it off, search-hard went 40/44 to 38/44, so main keeps it on.

### What not to do

- Don't put a setting idea in a pull request: a draft's bench answers it in seconds, and a pull request needs a deploy per try.
- Don't use merging and production as the test. A try that goes through CI, merge and production is about 30 minutes. Try code on its pull request's preview first.
- Don't trust the fake-embedder local bench (`--fake`) for a ranking change. It has passed changes the real gate failed. `search_bench` uses real embeddings.
- Don't tune to one bench. Read the cases that moved, and bench every set before promoting.

## Changing Tex

1. **Draft:** `tex_dev create`, then `edit` a step's model, effort, rounds, `ctx` (the modules it reads), wires or on/off. Open `link` to watch it in the Lab while you edit.
2. **Look:** `snapshot` (with a `test` for timings), `sim` for speed and cost, `compare` against main, and `check`.
3. **Try it:**
   - `test_chat open` (Maya, a Training or Dev conversation, or your own chat from just before a text), then `send` and read the run card.
   - `step` on the step that went wrong.
   - `edit` the draft, then `test_chat again` with it.
   - `test_chat try` runs one text on main and on the draft side by side.
   - Real models run, writes stay in the test chat, and the limit is 200 test texts a day per person.
4. **Measure:** `run { draft, quick: true }` runs only the unit tests of the steps the draft changed (every step's when a changed step has none of its own), and reads them against main's newest Dev run on the same models (it starts one beside it when main has none; `models: "cc"` costs $0 on the subscription), so `runs { draft }` ends in a `vsMain` verdict. `run { draft }` runs the whole Dev set. Training examples are edited through the Testing tab's conversations (`set_*`), not the prompts.
5. **Land it:** `promote` opens the pull request. The replay gate runs the sealed Test set, and production follows a green main.

A prompt's words, a new step's code and a capability need a pull request: node code in `packages/tex/gateway/agent/graph/nodes/`, words in `packages/tex/src/texPrompt/`. Merge new node code to main first, unwired and on the shelf (`texNodeShelf.json`). Then wire it in a draft, test it on rung 3, and promote.

## Changing Tex's quality (how well it texts)

A quality change fixes how Tex behaves: what it says, when it stays quiet, whether it does the work itself, how it reports. It starts from a bad interaction and ends as a win on the Dev set and the sealed Test set.

1. **Find the cause before changing anything.** Trace the turn: `chats`, then `moments`, then `turn`, then `prompt`. Name the step that went wrong and why: architecture, harness, capability, bug or model. Ask the person who saw it what was wrong and why before writing any rule. Never fit a fix to one or two examples, and never write a "this kind of message: stay quiet" rule.
2. **Pick the lever, cheapest first.** All of these are config or examples, so all are a draft:
   - **Training examples.** Judgment is taught by example conversations, not by rules in prompts. Add or edit a Training conversation and its labels (one message × one step) with `set_get`, `set_edit` and `set_create`, or turn a real chat into one with `set_import`. A real chat is never copied verbatim: the import refuses a line that shares six words in a row with the real text. `set_promote { ids }` starts the promote workflow at once; its pull request writes the conversations and rebuilds each step's Training module (`texTraining.generated.json`) and the Lab's data from them.
   - **What a step reads.** Edit its `ctx` (modules, history, `train:<nodeId>`), its model (Haiku for Tex's steps), effort, rounds, time limit or wires.
   - **A step on or off, or a new step.** New code goes to the shelf first, then gets wired in a draft (see Changing Tex above).
3. **Try it on the turn that went wrong.** `test_chat replay { chat, text, draft }` re-runs a real text on the draft. `test_chat try` runs one text on main and the draft side by side. `test_chat open` with a Dev or Training conversation (`source: "set"`) runs inside that conversation's world.
4. **Measure, not one example.** `run { draft, quick: true }` first: the changed steps' unit tests against main, in minutes. `run { draft, kind: "dev" }` replays the whole Dev set's unit tests, and `run { kind: "node", node }` runs one step's. Decide is exact, so one run is a result. The front door varies about three points between repeats, so judge it over repeats (`repeats` up to 5). A draft wins only if it is better on the cases it targets and no worse elsewhere.
5. **Promote.** The replay gate runs the sealed Test set on main. Nobody tunes against the Test set; it is people-only and never shown to an agent. Production follows green CI. Afterwards, check the real chat it came from.

Where it is decided: [test-sets](./decisions/testing/test-sets.md), [replay-gate](./decisions/testing/replay-gate.md), [tex-quality-architecture](./decisions/testing/tex-quality-architecture-2026-11-17.md).

## Changing the nightly (dream, About me, day summaries, housekeeping)

The nightly is its own graph on the Lab's Nightly page (`graph: "nightly"` in `texConfig.json`). It covers the dream, About me's upkeep and prune, day summaries and housekeeping. It runs once a night per person, so waiting for a real night is never the loop.

1. **Draft:** `create`, then `edit` a nightly step's model, effort, `ctx`, settings or wires. `snapshot { draft, graph: "nightly" }` draws it, and `link { graph: "nightly", draft }` opens it in the Lab.
2. **Run it now in a test chat:** `test_chat open` on your own 1:1, `use` the draft, then `test_chat nightly { testChatId, run: "dream" }` (or `"housekeeping"`). It runs the dream and every step the draft wires after it, with weekly steps forced, over the test copy of your workspace. It answers each step's output, About me's size before and after, the lines added and removed, and the run card. Nothing real changes.
3. **Read the result like a person would.** Did About me gain facts that are true and lasting, drop ones that expired, and stay under its cap? Are the day summaries right about that day? Repeat the run after each edit; it takes about a minute.
4. **For real, when it is right:** `test_chat nightly { real: true, draft }` runs it on your own workspace (at most 10 a day), and About me keeps its history so a bad run can be put back. Then `promote`.

Where it is decided: [dreams](./decisions/texting-assistant/dreams.md), [day-summaries](./decisions/texting-assistant/day-summaries.md), [housekeeping](./decisions/texting-assistant/housekeeping.md).

## Previews and debugging

- **A pull request's own copy:** every pull request gets a preview (Convex, gateway, Tex, web app) with fake people and fake Google. It is the sandbox for code changes: push as often as you need while you iterate. Use it with `tex_dev code { draft, code: "#<PR>" }` or `test_chat` on that code. See [preview-sandbox](./preview-sandbox.md).
- **Why a real turn went the way it did:** `chats`, then `moments`, then `turn`, then `prompt` / `jobs`. Replay shows only what ran.

## Keeping this guide current

A pull request that changes the Lab, its test chats, its bench or the previews updates this guide, [preview-sandbox](./preview-sandbox.md) or the `tex_dev` guide (`packages/lab/gateway/texDev/guide.js`) in the same pull request, and the Context note `products/tex/how-it-works/making-changes-in-the-lab.md` with it. CI enforces it (`scripts/check-lab-docs-updated.mjs`); a change nobody uses differently says `No Lab docs change: <why>` in its description. See [lab-docs](./decisions/testing/lab-docs.md).

## Where this is decided

- [search-config](./decisions/search/search-config.md)
- [draft-bench-runs](./decisions/search/draft-bench-runs.md)
- [config-graph](./decisions/texting-assistant/config-graph.md)
- [replay-gate](./decisions/testing/replay-gate.md)
- [test-set-service](./decisions/testing/test-set-service.md)
- [lab-docs](./decisions/testing/lab-docs.md)
