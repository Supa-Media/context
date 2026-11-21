# Search config

### Search runs from a config of its own, and its ranking constants are that config's settings

Decided by the owner, 2026-11-21 (the search plan: "we should probably have like a place in lab to edit like our
search config"; and "we can have like a texting config, text nightly config, and then search config because not only
text users search").

`apps/mcp/src/search/config/searchConfig.json` names every step a search runs, the settings each step ranks by, and
the wires between them, in the Lab's graph shape. It is search's own file, not a page of Tex's `texConfig.json`,
because an AI client's `search_notes`, the app's search bar and Tex all search the same way.

The steps read left to right (Dev2, 2026-11-21: "I should be able to follow from left to right and see how things are
being added to search results and things are being removed"), each one of four kinds, and each runs once for every
workspace asked at once:

| Step | Kind | Settings |
|---|---|---|
| Query (`search`), Open as you (`open`) | which workspaces, opened with the person's role and rules | |
| Words (`words`), Meaning (`meaning`), side by side | nominate | `minScore` |
| Only what you may see (`visible`), Drop search probes (`probes`), Close meaning only (`floor`) | filter | `meaningFloor` |
| Merge (`merge`) | merge: one row per note by reciprocal rank | `rrfK` |
| Title and phrase (`title`), Lower logs and archive (`prior`) | rank | `titleWeight`, `phraseBonus`, `snippetPhraseBonus`, `logPrior`, `inboxPrior` |
| Meaning-only budget (`budget`), Read snippets (`snippets`), Drop code passages (`code`) | filter | `extraNotes`, `looseReads`, `snippetChars` |
| Merge across workspaces (`fuse`, only when several answered), Answer (`answer`) | merge and rank across workspaces | `hits` and its own ranking knobs |

Merging is a step, not a wire: combining lists always needs a rule for scores, and a step holds that rule as
settings a draft can change. Each row keeps its parts apart (`w`, `m`, `title`, `prior`; `search/stages.js`), so the
Lab shows why a note ranks, and the try-out says how many notes each step handed on. A step that is off is passed
over (its wires joined), so a draft can score a search without it; `ALWAYS_ON` steps cannot be turned off. The two
nominators run side by side (the runner's `concurrent` option). `minScore`, `extraNotes` and `snippetChars` are the
defaults of the person-facing settings (`search/settings.js`), which a deployment's `SEARCH_SETTINGS` and a setup's
`search:` section still lay over.

`findNotes` runs those steps on the shared graph runner (`packages/tex/src/texGraph.cjs`), so the wires come from the
file, never from code; each step's code is `search/config/nodes.js`, by id. The constants that used to live in
`tools/search.js`, `meaning/serve.js`, `evidence.js` and `priors.js` (`RRF_K`, `LOOSE_PENALTY`, `TITLE_WEIGHT`,
`PHRASE_BONUS`, `BOOST_FACTOR`, the meaning floor, the loose read count, the 12 hits and the log prior) are the steps'
settings, read through `search/ranking.js`; callers not on the runner (ChatGPT's `search`, the console's imported
search) rank by main's settings of the in-workspace steps through `withMeaning`, which composes the same `search/stages.js` functions, so the two cannot drift. Each setting is bounded in `searchConfig.cjs`, which also refuses a setting a
step does not read, so no knob is drawn that does nothing.

`findNotes(..., { config })` searches on another config: a Lab draft's, checked against the schema first and refused
whole when anything in it is out of bounds.

**What a "simplification" would cost.** Putting the constants back in the code makes every ranking change a code
change with no Lab draft to try it on; folding the file into `texConfig.json` ties search, which every client uses, to
Tex's replay gate and schema.

**The test that fails if it is reversed.** `apps/mcp/test/searchConfig.test.mjs`: main's settings equal the old
constants, the run goes through every step left to right from the file's wires (fuse only across workspaces), a step that is off is passed over, and a draft's `hits` and `logPrior` change what
comes back.
