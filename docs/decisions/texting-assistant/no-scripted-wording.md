# Tex's code hands over facts and never writes what Tex says (2026-11-25)

Dev2, 2026-11-25, after Tex copied a code-written paragraph word for word into a group chat: "Tex has a lot of
hardcoded plumbing lines no? why is that", then, on the audit: "lets make sure this is a hard rule across dev and dev2
writers". A hard rule for every person and agent who writes Tex's code.

**What the audit found** (packages/tex at 29c3d8f). About 110 texts went to people with no model writing them (74 from
the texting Worker, such as "Done. I invited 1 person here…"), about 1,330 sentences of prompt were built in code
across 220 files (five and a half times what the Lab's prompt modules hold), about 55 of them dictated exact words
("say only…", "something along the lines of…"), and about 340 were checkers' and judges' send-back notes. The count
grew from about 200 in mid-October to about 2,700. Each bad interaction had been fixed by adding a sentence where it
showed up; the config graph (2026-11-14) moved the wiring into config but left the words in code; nothing counted them.

## The rule

- **Code hands Tex facts, as data.** Who, what, which state, what failed: fields and short labelled values, never a
  sentence for Tex to repeat or a paragraph explaining what to do about it.
- **Behaviour is taught, not written.** How Tex acts on a fact is a Training conversation, or, for a general policy,
  a Lab prompt module (`packages/tex/src/texPrompt/`). Never a rule written into code.
- **What Tex says to people, Tex writes.** A no-model text is kept only for when no model can run (the gateway, the
  chat's storage or the line itself is down), each on a named trigger that is logged and never silent.
- **The count only shrinks.** `scripts/tex-wording-check.mjs` counts every string of five or more words in Tex's code
  (tests, logs, thrown errors, tool descriptions and the capability list aside) against `packages/tex/wording.json`,
  per file, in the fast guards and in `pnpm precheck`. Only Dev2's own words, quoted on a line of the pull request's
  description (`Tex wording raised on the owner's call: …`), let it rise.

## The traps (Dev2, 2026-11-25)

1. **No prompt walls.** Moving the sentences verbatim into a prompt file only moves the mess. For each one, ask:
   - is it **factual state**? Pass it as data;
   - is it a **general policy or an example**? Put it in Training or a Lab module, once, in general words;
   - is it a **symptom of a missing tool or capability**? Build the tool, and delete the sentence.
2. **A wording fix can hide a logic bug.** Many of these were patches for missing state, wrong timing or a tool's bad
   output. Before rewording, find out which. A checker or judge returns a structured reason (what is wrong, about
   which fact), not a rewrite, so a real bug shows as one and is fixed where it lives.
3. **Moving a reply to the model needs its failure modes.** A no-model reply moved into a model turn is checked under
   rate limits, timeouts and a burst of texts in a group chat; when the turn cannot run, the outage line goes out on a
   clean trigger, never a hang or a silent drop.

## How a fixed text moves to Tex: node "Tex did" (2026-11-25)

- **The action still runs in code**, once, as before. Then the texting Worker queues one turn of the chat's own, as a
  saved login's turn is: `event: "did"`, asked by the person who asked for the action, under their text, with what
  happened as facts (`packages/tex/worker/didFacts.ts` `tellTex`): `{ action, status, ... }`, short names and short
  values only.
- **Node `did`** (`packages/tex/gateway/agent/graph/nodes/did.js`, `agent/did.js`) checks the facts and hands the
  Front door `{"from":"context","did":{...}}` as its question; its cause line is empty. Tex writes the text, taught by
  Training conversations.
- **Never silent.** A `did` turn that can't run (the chat can't run one now, no model, the daily limit, every retry
  failed, the queue full) sends the action's old line once, logged as `group_did` `unsaid_<why>`
  (`didFacts.ts` `didUnsaid`). A retry re-sends the facts and never repeats the action.
- **Config, not code.** The node merged on the shelf; until a Lab draft wires it (`did` to `fd`, when `tell`), the old
  line is sent exactly as before. First user: adding everyone in a group to a workspace (`groupInvite.ts`). Tests:
  `apps/mcp/test/texDid.test.mjs`, `packages/tex/worker/groupInvite.test.ts` (with the node wired: the facts reach the
  turn, the model out or the gateway down on every try sends the old line once, and the invite runs once).
- **Group commands next** (B2): the start, invite, mail-sharing and "what can you see" answers, a group run's
  refusal (`groupRunTurn.ts` `why`) and a side text that couldn't go, each as `{ action, status }` facts. A `did`
  turn never starts another (its own refusal goes as the old line), so nothing loops. **"Stop" and the once-per-mute
  reply stay fixed lines**: a muted chat runs no model by design (its grant is refused, `liveGrants.ts`), so the
  mute holds even with every model down. Test: `packages/tex/worker/groupDid.test.ts`.
- **People with no account yet** get texts Tex writes too (Dev2, 2026-11-25: Context is free, so nothing is billed);
  a per-number daily cap only keeps a spam number from running up model calls.

## What a "simplification" would cost

Adding one sentence where a bad reply showed up is the cheapest way to turn one failing case green, and it is how the
count grew more than tenfold in six weeks. Raising the list without Dev2's words, or moving sentences into a prompt
wall, brings that back. `node scripts/tex-wording-check.mjs --self-test` fails if the counter stops seeing a sentence,
a template, a `+` chain or a nested template, or starts counting logs, errors, tool descriptions, regular expressions,
comments or markup, or if a raise passes without the owner's line.

Related: [turn-told-from-state](./turn-told-from-state.md), [prompt-modules](./prompt-modules.md),
[group-hello](./group-hello.md) (the gateway writes the hello; the Worker sends no words).
