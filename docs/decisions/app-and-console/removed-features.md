# App and console: features removed rather than hidden

## Auto-organize, What changed and the app assistant are deleted, not switched off

Decided by the owner, 2026-10-17: *"remove 'app assistant' that doesnt exist
right now, remove auto organize and whats changed, all of those should be
deleted and thrown away, no way to access it in the app and not in use"*.

Gone, with their tests, screens and scripts:

- **Auto-organize** (Jev feature `organizer`): the daily sweep and its cron,
  the suggestions and the "without asking" switches, the Premium settings
  card and its line in "What Premium includes", the one-time notice, the
  explorer foot's "N suggestions" line, Undo on its activity rows, the start
  on upgrade in `billing.ts`, its trips through the file barrier, and the
  "Organizer Eval (live)" workflow (its icon steps live on as "Icon Suggest
  (live)").
- **What changed** (Jev feature `whatChanged`): the page in the document slot
  and its `?changes=1` address, the cards, the team routing "For your teams"
  (`organizerRoutes`), the writing half of `withJev` and the inference
  Worker's `/extract` route.
- **The app assistant**: `ai/production/app-assistant.md` is no longer read.
  In-app chat had already gone ([no-in-app-chat](./no-in-app-chat.md)), so a
  turn that is not texted has no production setup and uses the built-in words
  in `apps/mcp/src/agent/prompt.js`. The AI tab's catalog loses its row, and
  the auto-organize and What changed rows with it.

What stays, and why:

- **Jev and `/decide`.** Owner suggestions (`functions/owners.ts`) and the
  icon picker's suggested emoji (`functions/folderIcons.ts`) still ask Clef
  through them ([inference](../storage-and-credentials/inference.md)).
- **Old usage rows.** `jevUsage` and `aiModelUsage` keep rows under
  `organizer` and `whatChanged` until they age out; the AI costs report lists
  them under "(removed)" labels so its features add up to its total
  (`RETIRED_JEV_FEATURE_LABELS`).
- **The `organizerSettings` table's definition**, only until a deployment has
  emptied it with `functions/retiredTables:drainOrganizerSettings`: a schema
  push that drops a table still holding documents is refused, and a broken
  deploy is worse than a dead definition. Then the definition goes.
- **`.context/organizer/state.json`** in customer buckets. It is the
  customer's, it is harmless, and nothing reads it; export is unchanged.

**What bringing one back costs.** Each is a new decision here first, not a
switch flipped: the code, the cron, the screens and the tests that held their
privacy rules are deleted, and a feature that writes notes for people or
routes them to a team needs those rules proven again before it ships
([privacy-and-sharing](../privacy-and-sharing.md)). The checks that fail if a
piece creeps back: `jev.test.ts` ("auto-organize and What changed are gone
from the registry"), `decide.test.ts` ("has no /extract"), and
`agentInstructions.test.mjs` ("an app turn gets the built-in words: no
texting file, and the retired app file is never read").
