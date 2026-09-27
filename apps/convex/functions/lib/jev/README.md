# Jev smarts

Every feature that asks Jev anything goes through this folder. The reasons
are in `docs/decisions/storage-and-credentials/inference.md`.

## What Jev is

`typesafe/jev` on Cloudflare Workers AI, with zero data retention. You give
it text (`state`, up to about 100,000 characters) and up to 16 typed
questions. It returns answers and never writes text:

| type | criteria | answer |
| --- | --- | --- |
| `noul` (yes/no) | `{ true: "…", false: "…" }` | `{ type: "noul", noul: 0..1 }` |
| `choice` | `{ key: "description", … }`, up to 64 | `{ type: "choice", choice, confidence, probabilities }` |
| `score` | `["level 1", "level 2", …]`, up to 10 | `{ type: "score", score, confidence, legend, probabilities }` |

Each question is `{ type, instructions, criteria }`. It costs $0.042 per
million input tokens, and output is free.

## Adding a feature

1. Register it in `features.ts`:
   `myFeature: { label, onByDefault: false, dailyCallsPerWorkspace, plan: "premium" }`.
   The name is permanent, because usage and switches are keyed by it.
2. Ask from an action, never from anywhere else:

   ```ts
   import { withJev, eachLimited } from "./lib/jev/client";

   await withJev(ctx, { feature: "myFeature", workspaceId }, async (jev) => {
     if (!jev) return; // off, not Premium, over the cap, or no Worker configured
     await eachLimited(items, 4, async (item) => {
       const answers = await jev.decide({ state: item.text, questions });
       if (!answers) return; // failed or refused: "no opinion", never a guess
       // read answers[questionName]
     });
   });
   ```

3. Read note text through the file barrier (`files.runFileOperation`) at the
   caller's clearance. Skip encrypted notes. Never store a question, an answer
   or note text in Convex. Anything that names a note goes in the customer's
   bucket under `.context/`.
4. Keep the pure parts (building questions, reading answers) in plain modules
   with tests. `apps/mcp/src/organizer/` is the worked example.
5. Flip `onByDefault` to `true` in the PR that ships the feature's screens.

Do not call `fetch` on `/decide`, and do not name the model outside this
folder. `__tests__/jev.test.ts` fails if you do.

## Usage and cost

- `jevUsage` has one row per UTC day, feature and workspace: calls, failed,
  refused, questions, tokens (estimated as characters ÷ 4), `costMicroUsd`
  and ms.
- Staff read `api.functions.admin.jevUsageReport({ days })`, which gives
  totals and daily series per feature, with each switch's state.
- `JEV_USD_PER_MTOK` in the Convex environment overrides the price.

## Turning it off

- One feature: `admin.setJevSwitch({ feature: "organizer", off: true })`.
- Everything: `admin.setJevSwitch({ feature: "*", off: true })`.
- Back to the registry default: `off: null`.
- Without the database: set `JEV_DISABLED` to `all` (or `organizer,other`) in
  the Convex environment.

A switch takes effect on the next `withJev`. A feature whose switch is off
should behave as if it does not exist, as `organizer`'s
`organizerAvailable` does.
