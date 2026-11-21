# Search config

### Search runs from a config of its own, and its ranking constants are that config's settings

Decided by the owner, 2026-11-21 (the search plan: "we should probably have like a place in lab to edit like our
search config"; and "we can have like a texting config, text nightly config, and then search config because not only
text users search").

`apps/mcp/src/search/config/searchConfig.json` names every step a search runs, the settings each step ranks by, and
the wires between them, in the Lab's graph shape. It is search's own file, not a page of Tex's `texConfig.json`,
because an AI client's `search_notes`, the app's search bar and Tex all search the same way. Its steps:

- **Search** (`search`): which workspaces are asked.
- **Search each workspace** (`each`): every workspace at once, each through the six steps below, which it calls over
  `uses` wires, once per workspace, each logged as a run of its own:
  - **Open the workspace as you** (`open`): the person's role there and its privacy rules.
  - **Find by words** (`words`) and **Find by meaning** (`meaning`, `minScore`), side by side, each only notes the
    person may see.
  - **Merge words and meaning** (`merge`): reciprocal rank, the meaning floor, title and phrase evidence.
  - **Lower logs and archive** (`prior`, `logPrior`).
  - **Add meaning-only notes** (`snippets`, `extraNotes`, `snippetChars`, `looseReads`).
  `minScore`, `extraNotes` and `snippetChars` are the defaults of the person-facing settings (`search/settings.js`),
  which a deployment's `SEARCH_SETTINGS` and a setup's `search:` section still lay over.
- **Rank across workspaces** (`fuse`): every workspace's hits ranked together, at most `hits` shown.

Each step is a piece a search can be judged by on its own (Dev2, 2026-11-21: "the nodes are actually like decent
chunks... that can be tested in of itself"): a Lab draft can turn one off (words off searches by meaning alone,
meaning off by words alone, prior off keeps logs level) or change only its settings, and the Lab's try-out shows
each step's time per workspace.

`findNotes` runs those steps on the shared graph runner (`packages/tex/src/texGraph.cjs`), so the wires come from the
file, never from code; each step's code is `search/config/nodes.js`, by id. The constants that used to live in
`tools/search.js`, `meaning/serve.js`, `evidence.js` and `priors.js` (`RRF_K`, `LOOSE_PENALTY`, `TITLE_WEIGHT`,
`PHRASE_BONUS`, `BOOST_FACTOR`, the meaning floor, the loose read count, the 12 hits and the log prior) are the steps'
settings, read through `search/ranking.js`; callers not on the runner (ChatGPT's `search`, the console's imported
search) rank by main's `merge`, `prior` and `snippets` settings, composed as one (`withMeaning`). Each setting is bounded in `searchConfig.cjs`, which also refuses a setting a
step does not read, so no knob is drawn that does nothing.

`findNotes(..., { config })` searches on another config: a Lab draft's, checked against the schema first and refused
whole when anything in it is out of bounds.

**What a "simplification" would cost.** Putting the constants back in the code makes every ranking change a code
change with no Lab draft to try it on; folding the file into `texConfig.json` ties search, which every client uses, to
Tex's replay gate and schema.

**The test that fails if it is reversed.** `apps/mcp/test/searchConfig.test.mjs`: main's settings equal the old
constants, the run is `search -> each -> fuse` from the file's wires with each workspace's six steps run once each, and a draft's `hits` and `logPrior` change what
comes back.
