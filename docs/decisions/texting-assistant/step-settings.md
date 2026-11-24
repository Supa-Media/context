# A Tex code step declares its own settings, and the config holds their values (2026-11-23)

Until 2026-11-23 a Tex step's config held its model, effort, time limit, wires
and reads, but not the numbers and switches inside its code. The prose limit a
reply is sent back over, the words allowed beside a page, whether "Text them"
trims an opening "Absolutely," or adds the link to a saved note: each was a
constant in the gateway. The shadow-code audit of that day
(`projects/tex-quality/shadow-code-audit-2026-11-23.md` in the team's notes)
found these change what Tex sends while the Lab shows nothing of them. Dev2
asked: "code nodes should be able to define their own parameters, like number
parameters or Boolean parameters ... display that in the UI, and agents are
able to tweak those parameters", and said "build" on the artboards.

The decision: **a code step declares each setting it reads, and the config
holds its value.**

- **The declaration is code**, in `packages/tex/src/texNodeSettings.cjs`
  (`STEP_SETTINGS`): per step id, each setting's kind (a number with `min`,
  `max` and optionally whole, on or off, or one of a few choices), its default,
  its label and its tip. A new setting is a pull request: declare it with
  main's behaviour as its default, read it in the step's code with
  `settingsOf(env, id)` (`texConfig.js`), and give main's config that default.
  So adding a setting never changes what Tex does; changing its value does.
- **The value is config**, a step's `settings` in `texConfig.json` (schema 5).
  `configProblems` refuses a name no declaration has ("a setting nothing
  reads") and a value its declaration does not allow; `tex_dev check` and
  Promote refuse the same. The gateway reads a refused or missing value as its
  default, so a bad draft can never run on a value nobody checked.
- **A Lab draft changes it like any field**: the Lab draws a step's declared
  settings under its Settings card as "Settings · from the code" (a number
  box, a switch, a picker; the bound said under a number it refuses; a change
  outlined with main's value), and `tex_dev edit` sets them with
  `{ op: "set", node, field: "settings", value }`. A test chat on the draft
  runs its value (`withDraft` / `draftStep`).

The first settings were Text them's `trimFlattery` and `linkSavedNote` and Answer check's `proseWords` (70) and
`besideResultWords` (30), all on the old constants' values. Since the no-shadow steps (2026-11-24,
[no-shadow-steps](./no-shadow-steps.md)) they live on the steps whose code reads them: Finish the text
(`trimFlattery`, `linkSavedNote`, `dropStaleAnswer`), Claim checks (`onTexts`, `proseWords`, `besideResultWords`) and
Tool rules (`sameAsk`, `folderFit`, `noteLinks`).

Search's settings stay its own (`searchConfig.cjs` bounds,
`SEARCH_SETTINGS_BOUNDS`): that architecture has its own config and schema.

**What a simplification would cost.** Reading a number from the config without
a declaration lets a draft set any name, and a typo runs as the default with
nothing said. Dropping the default-equals-main rule makes adding a setting a
behaviour change that no draft tried. Checking settings in the Lab only lets a
`tex_dev` edit promote a value the gateway would refuse.

**Tests that fail if reversed:** `apps/mcp/test/texNodeSettings.test.mjs`
(schema refusals, defaults, a draft's value running, the prose limit following
the setting, `tex_dev check`), `scripts/tex-lab-promote.mjs --self-test`
(Promote refuses a bad setting), and `packages/lab/__tests__/texLabStepPanel.test.ts`
("a code step's own settings").
