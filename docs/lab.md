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
| 5. GitHub runs | The Dev set, a full eval, the examiner | `tex_dev run`, `eval_run` (a Dev or Training run takes 24 Front door tests and 8 other tests at once, to stay under 10 minutes) | minutes |
| 6. Promote and merge | Land a change that won | `tex_dev promote { draft }` opens the PR, then CI, the gates, merge and production | about 30 min |

Rungs 1 to 3 need no pull request, no GitHub job and no deploy, so a config change stays on them. A code change iterates on rung 4: its pull request's preview is the sandbox for code, and each push is a try. Rung 6 lands what already won; it is never how you try something.

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

The real set (`search-real`) grows from Tex's own failed searches: `tex_dev failed_searches { chat, days }` lists, in one call, each note search Tex ran again or gave up on, with its top hits and the note Tex read in the end. Rewrite each into a case, never verbatim, with made-up notes of the same shape.

`search_bench { list: true }` names the benches that have saved queries. A bench's queries are saved by its last Lab eval run on main (`tex_dev eval_run { bench, code: "main" }`, once). Re-run that after a change to the index code (`searchIndex.js`, `meaningIndex.js` and the bench object files), because those rebuild the bench worlds. A Lab eval search run on main's code also adds its score to the metrics sheet (`bench:<id>`, right note first and top 5; `scripts/metric-rows.mjs bench`), which the Search area reads; a pull request's run doesn't.

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
   - A chat opened at `base` reads the chat's conversations (its threads, their titles and summaries) as they stood when that text arrived, never as they are now, and the threads a test text's turn sorts stay in the test chat (since 2026-11-26: before, a copy started before a send read the thread summary saying it was sent). Other notes Tex keeps for the chat (about-me, the playbook) are still read as they are now.
   - A test chat of a real group chat is told the chat's shared mail and calendars as a real turn is (since 2026-11-26), each mailbox marked for the text's sender when they have it connected themselves (`askerSends`, [chat-mail](./decisions/texting-assistant/chat-mail.md)), so `send { as }` shows what Tex does with a shared mailbox for each person. Its searches and opened emails are real reads of that mail, through the share as the chat reads it, and only while you are in the chat (`labChatMail`, since 2026-11-26: before, a copy ran on your own token, which reads nobody's mail); an email Tex sends from it is kept in the test chat, never sent, and Tex is told it is held for the 👍 of whoever it goes from (`as`, or the sender), as the real gate holds every texted email (since 2026-11-26: before, a test chat told Tex "Sent", and a turn that rightly offered it for someone's 👍 said it had gone).
   - Stickers: `test_chat react { testChatId, msgId, sticker: true }` (or the 🏷️ in a text's tapback menu) sticks a sticker on a text, as Photon's line hands one. The chat keeps it for Tex, and its line reads "sticker s1a2b3c on …". While the Tapback step's **Chat stickers** setting is on in the draft, Tex's tapback can stick it back on a later text, shown as the event line "Tex stuck a sticker on a message." Its `send_sticker` action runs for real in a test chat too: the kept sticker goes on the test chat's line after Tex's words, as its own picture. The `react` step's output says which sticker went, or why the emoji went instead. A test chat opened from a real chat (your own 1:1, or a group, shared or yours) starts with the stickers that chat kept, with what each shows, as its chat object holds them: Tex's turns there are handed the same sticker list as the real chat's, so "send me a sticker" can be tried without a real text. `test_chat about` counts them (`stickers`).
   - Group chats: `test_chat open { source: "world", world: { people, sponsor?, speaksUp?, introduced?, start? } }` makes up a group (people on Context with roles, people who are not, guests invited by number). On main, the default, nobody is made: the people live only in the test chat, with roles in your own shared workspaces (`test_chat worlds` lists them; never personal, never the pinned one), and Tex reads what a real chat of theirs would reach, on your own access and never more: each text reads its sender's own shared workspaces, at their role, as a real chat's does since 2026-11-25 ([asker-reach](decisions/texting-assistant/asker-reach.md)), so `send { as }` decides what the turn can open. The turn is also told which of the sender's workspaces someone here isn't in (`unshared`, as a real chat's answer names them since 2026-11-26), so the Room check ([room-check](decisions/texting-assistant/room-check.md)) runs on a made-up chat as on a real one. With `code: "#<pr>"` the people are made on that pull request's preview, in its made-up Lumio, Maison Solenne and Common Ground, and the preview's real group rules run on them. `send { as }` texts as anyone; `join` and `leave` change who is here; `added { as }` (any group test chat, and the **Tex added** button beside Reset) has that person add Tex's number to the group, as Photon's `participantAdded` reaches the chat object: on a config with node `joined` (Tex added, on main since 2026-11-25) Tex says hello once per group, so a fresh test chat tries it again, and a draft with it off says nothing new; each reply row's `group` says what the chat reached and why. In the Lab, the chat picker's **Made-up chats** tab opens the same chats: seven ready-made scenarios or a setup of your own (people, accounts, roles, who brings Tex in, how much Tex joins in, earlier texts), then a Chat view drawn like iMessage, with a why line under each text, Add someone and leave, and texting as anyone. Tex's own sends show as its iMessage line would send them: an effect under its bubble (Invisible Ink hidden until clicked), a poll as its card, an @handle as that person's tag, and naming the chat, its photo or adding someone as event lines; a person's typed "@Tex" stays plain words, as iMessage sends it. On main the setup's columns and the scenarios use your own shared workspaces (the first four). On a pull request, pick an open one: a merged or closed one has no preview, and opening a chat on it is refused with that reason. While the preview starts (about a minute), you can already pick who you are texting as.
4. **Measure:** `run { draft }` runs the Dev set's unit tests on GitHub. Training examples are edited through the Testing tab's conversations (`set_*`), not the prompts.
5. **Land it:** `promote` opens the pull request. The replay gate runs the sealed Test set, and production follows a green main.

A code step's own settings (Dev2, 2026-11-23) are config too. A step's code declares each one in `packages/tex/src/texNodeSettings.cjs`: a number with bounds, on or off, or one of a few choices, with its default. Finish the text, Claim checks and Tool rules have them today ([no-shadow-steps](./decisions/texting-assistant/no-shadow-steps.md)). The Lab draws them on the step's Settings card under "Settings · from the code", and `edit { ops: [{ op: "set", node, field: "settings", value: { ... } }] }` changes them in a draft. `check` and Promote refuse a value the declaration doesn't allow, and a test chat on the draft runs the draft's value. Adding a setting is code: declare it with main's behaviour as its default and read it with `settingsOf(env, id)` ([step-settings](./decisions/texting-assistant/step-settings.md)).

Components (Dev2, 2026-11-26) keep the canvas readable when many groups use one: a group with `component: true` (`edit { ops: [{ op: "group", id, value: { label, component: true } }] }`) is still one set of steps, and only its drawing changes. Where every wire to it meets another group's box, its box and those wires are not drawn on the canvas; opening a group that uses it shows a dashed teal reference card under each step that calls it ("◇ Jobs · 2 uses ⤢"), and clicking the card opens the component. The sidebar lists every component under Architecture, with how many places use it. `reference { topic: "groups" }` says the same: `component`, `usedBy`, and `as: "card"` on each wire drawn as a card. Folding, saving and Promote see the same steps and wires as before.

A New run step (kind `run`, Dev2, 2026-11-26) is where work that finishes outside a run starts a new one: its one generator wire goes to the input step it starts, or nowhere. Its code says which input steps it can start (`packages/tex/src/texRunNodes.cjs`), and `check` refuses a wire to any other. The side panel shows it as **Starts a new run at**, and picking there rewires it; `tex_dev edit` does the same with `unwire` and `wire` (mode `generator`). `reportRun` decides where a background job's report goes: the texting Worker reads its wire before it queues the report (`reportStartsAt`), and with no wire the report is logged as `report_not_run` and dropped. A config without the step starts `jobReport`, as before. The Add menu's **New run** draws one, but a run step no code reads does not pass `check`.

Tex's code never writes what Tex says (Dev2, 2026-11-25, a hard rule): hand a step facts as data, teach behaviour with Training conversations, and put a general policy in a prompt module, never a sentence in code. What code did for a chat (an invite, a shared mailbox, a refused group change) reaches Tex as a turn of its own from node `did`; a Training conversation shows one as a trigger row with `via: "did"`, spoken by Context, its text the facts as Tex is handed them (`tex-did-group.json`). Test chats count `joined` and `did` as triggers, never as steps that didn't run. `scripts/tex-wording-check.mjs` fails a pull request that adds wording to Tex's code ([no-scripted-wording](./decisions/texting-assistant/no-scripted-wording.md)).

A prompt's words, a new step's code and a capability need a pull request: node code in `packages/tex/gateway/agent/graph/nodes/`, words in `packages/tex/src/texPrompt/`. Merge new node code to main first, unwired and on the shelf (`texNodeShelf.json`). Then wire it in a draft, test it on rung 3, and promote.

## Changing Tex's quality (how well it texts)

A quality change fixes how Tex behaves: what it says, when it stays quiet, whether it does the work itself, how it reports. It starts from a bad interaction and ends as a win on the Dev set and the sealed Test set.

1. **Find the cause before changing anything.** Trace the turn: `chats`, then `moments`, then `turn`, then `prompt`. Name the step that went wrong and why: architecture, harness, capability, bug or model. Ask the person who saw it what was wrong and why before writing any rule. Never fit a fix to one or two examples, and never write a "this kind of message: stay quiet" rule.
2. **Pick the lever, cheapest first.** All of these are config or examples, so all are a draft:
   - **Training examples.** Judgment is taught by example conversations, not by rules in prompts. Add or edit a Training conversation and its labels (one message × one step) with `set_get`, `set_edit` and `set_create`, or turn a real chat into one with `set_import`. A real chat is never copied verbatim: the import refuses a line that shares six words in a row with the real text. `set_promote { ids }` starts the promote workflow at once; its pull request writes the conversations and rebuilds each step's Training module (`texTraining.generated.json`) and the Lab's data from them.
   - **What a step reads.** Edit its `ctx` (modules, history, `train:<nodeId>`), its model (Haiku for Tex's steps), effort, rounds, time limit or wires.
   - **A step on or off, or a new step.** New code goes to the shelf first, then gets wired in a draft (see Changing Tex above).
3. **Try it on the turn that went wrong.** `test_chat replay { chat, text, draft }` re-runs a real text on the draft. `test_chat try` runs one text on main and the draft side by side. `test_chat open` with a Dev or Training conversation (`source: "set"`) runs inside that conversation's world.
4. **Measure, not one example.** `run { draft, kind: "dev" }` replays the Dev set's unit tests, and `run { kind: "node", node }` runs one step's. The steps that run alone are the front door, Decide, the router, the reply reviewer, the job check, Before asking (askGate: label `to`, with back and job both scored as "climbs"; its reply is the Tex rows after the message) and the egress judge (label `allow`, with the step it judges recorded on the message as `rec.egress { action, subject? }`); a label on any other step reports "can't run alone yet". Decide is exact, so one run is a result. The front door varies about three points between repeats, so judge it over repeats (`repeats` up to 5). A draft wins only if it is better on the cases it targets and no worse elsewhere.
   - **Front door completion (since 2026-11-26).** `pnpm ai run texting-assistant --dir apps/mcp/bench/ai --test fd-completion`, then `pnpm ai judge <result>` and `pnpm ai score <result>` (both with `--dir apps/mcp/bench/ai`), runs six invented asks the front door must finish in one pass: a calendar move, an email draft, a note correction, a carry-on from a shared folder, a look in the next source before "I don't know", and a three-part ask. Each case line ends with the metrics it measures (`[metrics: task_completion_rate, cant_first_rate]`, `apps/mcp/bench/metrics.mjs`), the Area 1 ids of `@supa projects/tex-quality/eval-metrics.md`, and the score note prints each one's rate under the scores (`### Metrics`). Any bench file can tag its lines the same way. Six conversations at `runs: 1` take about two minutes on the default six processes and cost about $0.40 (Tex on Haiku, the played person on Sonnet, the judge on Haiku); `--runs 3` is about $1.20.
   - **Group chats and cross-chat asks (harness since 2026-11-26).** `--test groups` runs whole turns in the band workspace's group chat (`group: band`); `--test cross-chat` runs Maya's 1:1 with her band chat (`groups: band`, `apps/mcp/bench/crossWorld.mjs`): an `ask_chat` the Cross-chat gate lets go runs in the band chat's own turn and its answer starts her 1:1's run, as the texting Worker carries an ask, so a case grades the relayed answer, not only the asking turn. The bench's group grant holds the tagger's own role (a member's tag is read-only, as production's asker reach), and `- shared here: calendar of @priya` (or `mail of`) gives a case's chat that member's share. Their lines carry the Area 2 ids (`personal_leak_rate`, `permission_scope_compliance`, `sender_identity_accuracy`, `cross_chat_routing_honesty`, `group_signal_to_noise`). Every case is `drafted` until Dev2 signs off, so a run skips them and costs nothing; once un-drafted, the eleven cases at `runs: 2` cost about $0.50.
5. **Promote.** The replay gate runs the sealed Test set on main. The reply reviewer runs three times there and fails only when a case is wrong every time on the change and right every time on main; one unlucky sample does not block the pull request. Nobody tunes against the Test set; it is people-only and never shown to an agent. Production follows green CI. Afterwards, check the real chat it came from.

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
