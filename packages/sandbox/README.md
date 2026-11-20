# @context/sandbox

The tooling for per-pull-request preview sandboxes. Each preview is its own Convex deployment plus three Workers on
workers.dev, seeded with fictional personas. For what is real in a preview, what is mocked and what is planned, see
[docs/preview-sandbox.md](../../docs/preview-sandbox.md). For why previews work this way, see
[docs/decisions/testing/preview-environments.md](../../docs/decisions/testing/preview-environments.md).

Nothing here is deployed. The GitHub workflows run these files directly with `node`.

| File | What it does | Run by |
| --- | --- | --- |
| `src/config.mjs` | Renders each Worker config's `env.preview` section for one pull request and checks it names nothing of production's | `deploy-preview.yml` |
| `src/guards.mjs` | Refuses to deploy a preview that could text, mail or reach production | `deploy-preview.yml` |
| `src/convex-env.mjs` | Copies the allowed backend variables onto the Convex preview | `deploy-preview.yml` |
| `src/seed.mjs` | Seeds the personas, their workspaces, storage and notes | `deploy-preview.yml` |
| `src/smoke.mjs` | Proves the deployed preview answers end to end | `deploy-preview.yml` |
| `src/browser.mjs` | Opens the preview's `/login` in Chromium and fails on page errors or failed requests to its own hosts | `deploy-preview.yml` |
| `src/sign-in-code.mjs` | Mails a persona's sign-in code to the team inbox | `preview-sign-in-code.yml` |
| `src/cleanup.mjs` | Deletes a closed pull request's preview, and sweeps for any left behind | `preview-cleanup.yml`, `deploy-preview.yml` |
| `src/teardown.mjs` | Empties buckets, revokes tokens, deletes the Convex preview, and verifies nothing is left | `cleanup.mjs` |
| `src/resources.mjs` | The registry of everything a preview owns (with its teardown) or only uses (with the reason it needs none) | `resources-check.mjs`, its test |
| `src/resources-check.mjs` | Fails CI when a preview gains a kind the registry does not account for | Fast Guards |

## Adding something to a preview

If a preview starts creating a new kind of thing, add it to `OWNED` in `src/resources.mjs`. The entry needs its teardown
in `cleanup.mjs` or `teardown.mjs`, and its line in `verifyGone`. `src/resources.test.mjs` then runs cleanup against a
fake account that holds one of the new kind, and fails unless the teardown removes it and the gone-check notices when it
does not. If the preview only uses a kind, add it to `USED_BINDINGS` or `API_FAMILIES` with the reason it needs no
teardown.

## What lives in the apps instead

These pieces run inside a deployed app, so they stay with that app:

- **Texts simulator:** `apps/agent/src/simulator*.ts`, `apps/agent/src/simulatedGroup.ts` and
  `infra/router/src/textsSimulator.ts`. They are on only where `SIMULATOR` is `on`.
- **The Convex seed and preview naming:** `apps/convex/functions/seed.ts` and
  `apps/convex/functions/lib/previewDeployment.ts`. Convex deploys only what is under `apps/convex/functions`.
- **The `env.preview` sections:** the three Worker configs, `apps/mcp/wrangler.toml`, `apps/agent/wrangler.jsonc` and
  `infra/router/wrangler.jsonc`, which `src/config.mjs` renders.
- **The workflows:** `.github/workflows/deploy-preview.yml`, `preview-cleanup.yml` and `preview-sign-in-code.yml`.

Tests: `pnpm --filter @context/sandbox test`. In CI, `seed.test.mjs` and `smoke.test.mjs` are left out because they
import the Convex client.
