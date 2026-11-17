# What a turn is told about itself comes from state, never a stock sentence (2026-11-17)

Dev2, 2026-11-17, after a day in the Battle of the Bots chat: "can u find out the underlying issue why this keeps
happening? its a category of bug that keeps surfacing". Chosen: keep the words, then facts from data.

**The category.** Code writes facts about the turn into Tex's prompt as typed sentences, and nothing tied them to
the state they describe:

- every group turn was told "@<sponsor> tagged you.", a chat's own check-in included, which then texted "Yeah, what
  do you need?" every four hours, and a follow-up the judge picked up was explained as "you'd just tagged me";
- every group turn got the 1:1's own record, check-in and ping words, so it was told its history is in "their
  personal workspace";
- no turn was told whether its chat is shared with the developers, so a chat shared for a day was told "Dev2 can't
  see this chat", and Tex made up who could say yes.

A missing fact is silent, so the model fills it; and the words code builds were never kept, so Replay and the reviews
saw the wrong answer but never the wrong fact it was handed.

**Facts from state, step one (this change).**

- The Worker names why a group turn runs (`apps/agent/src/groupCause.ts`: `check_in`, `routine`, `job_report`,
  `cross_chat`, `reaction`, `tagged`, `named`, `judged`), and `groupTurn.js` `taggedLine` says "tagged you" only for
  a text that names Tex. A turn with no cause (an older Worker) is told as before.
- `turnPrompt.js` keeps `transcripts`, `checkIns` and `attention` to a 1:1 (`inGroup`).
- The control plane names a group chat's sharing with the developers on every group turn
  (`lib/texLabShared.ts` `devShareOf`, the list's own rule: `shared`, who said yes, who keeps it out), the Worker
  passes handles only, and the front door is told it when its `ctx` reads `devShare` (`agent/devShare.js`). It names
  who, never a rule: people with no account are not counted, as the list never counts them.

**Next.** Every block's words kept in the turn log and shown in the Lab, Replay and `tex_dev prompt`; each fact line
built from a field, saying "not known" when the field is missing, with a test that fails when a line claims what its
field doesn't hold.

**What a "simplification" costs.** Saying "tagged you" whatever ran the turn brings back the unprompted check-in
replies and the invented explanations. Tests: `apps/mcp/test/devShare.test.mjs`, `apps/agent/src/groupCause.test.ts`,
`apps/convex/__tests__/texLabShared.test.ts`, replay case `group-told-why`.

## Every module's words are kept beside its fingerprint (2026-11-17)

Until now a turn kept, per model round, each prompt module's id, length and fingerprint, never its words
(`promptManifest.js`, Dev2, 2026-11-14), and the Lab showed words only for modules the prompt catalogue rebuilds at
the turn's commit. Seven of a group turn's thirteen modules (the time, why the turn ran, the thread note's parts, the
workspaces it reaches, the model line) are built from the moment, so Replay and `tex_dev prompt` showed `words: null`
for exactly the lines that were wrong: nobody could read "@shyoh tagged you." on a check-in without rebuilding it by
hand. Dev2 chose to keep them.

- `turnPrompt.js` hands `prompt.words`, `{fingerprint: text}` for every module but the stable rules
  (`keptWordsOf`); a module over 16,000 characters keeps its fingerprint only.
- `turnTiming.js` keeps them in the reply's round, each once a turn (a later round sending the same bytes keeps none),
  only for fingerprints that round's manifest names, at most 48,000 characters a round.
- The Lab (`engine/promptAt.ts` `wordsOf`), Replay's Prompt panel and `tex_dev prompt` show the catalogue's words or
  the kept ones, the kept ones only when they hash to the fingerprint and length logged.

They live in the chat's own history, beside the texts they were built from, so they reach nobody the history does not.
A turn grows by roughly the size of its moment-built modules (6 to 20 KB in a group turn); the history the model reads
never includes a reply's timing (`conversation.js` `keptTurn`). What a simplification would cost: dropping the words
again hides the next wrong fact the same way (`apps/mcp/test/promptManifest.test.mjs`); showing kept words without the
fingerprint check shows words that did not run (`apps/mobile/__tests__/texLabPromptAt.test.ts`).
