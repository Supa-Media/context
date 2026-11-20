# The preview sandbox: what is real, what is mocked, what is planned

Every pull request from a branch in this repository gets its own live copy of
Context and Tex (`.github/workflows/deploy-preview.yml`): a Convex preview
deployment, the gateway with fresh Durable Objects, the texting assistant, and
the router with the web app, all named `pr<N>`. It is seeded with five
fictional personas and 41 notes, sends no texts or mail, and is deleted when
the pull request closes. Why it is built this way is in
[preview-environments](./decisions/testing/preview-environments.md); this page
is the catalog of how it differs from production.

Last checked 2026-11-20 against the live account, the deploy and cleanup logs,
and the code. "Checked on every preview" means the deploy's smoke test
(`scripts/preview-smoke.mjs`) proves it each push.

## How to use one

1. Open a pull request and push. The **Preview** check deploys it, and a comment
   on the pull request names the Workers.
2. Sign in to the web app: run **Actions → Preview sign-in code** with the pull
   request number and a persona (`alpha` to `epsilon`). The code is mailed to the
   team inbox. On the preview's `/login`, type `alpha@supa.media`, then the code.
   Do not press "send me a code" first: it replaces the code, and a preview
   sends no mail.
3. Text Tex in the app's Tex chat, or at `/texts-simulator` on the texting
   assistant's host from a 555-01XX number. Nothing reaches a real phone.

## Real, as in production

| What | How it is known |
| --- | --- |
| Its own Convex deployment, Workers and Durable Objects (notes, Tex's chats, jobs, the Lab sandbox) | Named `pr<N>`; the guards refuse any production or staging identifier (`scripts/preview-guards.mjs`) |
| Five personas, their workspaces, memberships and 41 fixture notes, in managed buckets of their own | The seed, every preview |
| Tex answering a text through the simulator (1:1), and in the app's Tex chat | Checked on every preview |
| Search by meaning (the workspace object's index, Workers AI embeddings) | Checked on every preview |
| The models Tex calls: real, through the AI gateway, billed like staging | The gateway's secrets |
| Web search, maps | Same keys as staging |
| Teardown: Workers, Workflows, Durable Objects, Convex deployment, emptied buckets, search databases, indexes and scoped R2 tokens, each checked gone | `scripts/preview-teardown.mjs` `verifyGone`; a leftover fails the cleanup run |

## Mocked, because a preview cannot have the real thing

| Production has | The preview has instead | Why |
| --- | --- | --- |
| Texting lines (Photon iMessage, Sendblue, Linq, WhatsApp) | The texts simulator and the app's Tex chat | A line is a real phone number shared by every customer; a preview must never text a real person |
| Outgoing email and SMS (sign-in codes, invitations, Tex's mail) | Nothing is sent. Sign-in codes are issued by CI and mailed only to the team inbox | Same reason: no mail key ever reaches a preview |
| Mail in (a personal workspace's capture address) | None | Mail routing is per domain; a preview has no domain of its own |
| Billing (Stripe) | A test Premium switch the seed turns on | No payment key on a preview |
| The per-workspace search database (D1) and Vectorize | The workspace object's own word and meaning indexes | A preview's config may not bind D1, Vectorize or R2 (`preview-config.mjs`); the object indexes are production's first choice anyway |
| Tex's examples index | Off | It is production's shared index and refused on a preview (`texExamplesIndex.ts`) |
| Its own screenshot, transcription and Tex eval Workers | Staging's, shared by every preview | One copy is enough for stateless helpers |
| The desktop and phone apps | The web app only | Native builds are separate, manual releases |
| Google sign-in, Gmail and Calendar | None: sign in with a persona code; test Google on staging | Google accepts only redirect addresses registered in advance, and every preview's host is new (Dev2 chose to keep Google out of previews, 2026-11-20) |

## Known gaps, planned

| Gap | Plan | Status |
| --- | --- | --- |
| Group chats | A group mode in `/texts-simulator`: 555-01XX members, the real group path, replies to the group's log. Background jobs, cross-chat asks and routines in a simulated group refuse to send for now | Merged (#3796); on a preview after its next push |
| Web app in a real browser | A smoke check: Chromium opens `/login` with no page errors | In review (#3790) |
| Background jobs | Unproven on a preview: asked from the app chat for a job, Tex answered directly and no job ran (pr3790, 2026-11-20). Next: a task that needs a job, and job reports to the app chat and the simulator | Open |
| Texting as beta or gamma | Their simulator numbers (555-0102, 555-0103) answered "your notes aren't ready": the seed skipped storage for workspaces with no fixture notes. Now provisioned | Fixed in this change |
| Word search checked by the smoke test | One exact-word search beside the meaning search | Planned |
| A Lab run aimed at a preview runs the pull request's code as a replay on GitHub; it does not call the preview's gateway or data | Run against the preview's gateway | Planned |
| The Lab run's records are kept in production's Convex | Keep them in the preview | Planned |

## Will not be supported

- Real texts, calls or mail to or from a preview.
- Real payments.
- Google sign-in, Gmail and Calendar (staging only).
- Any production or staging data in a preview, including the `context-lc` site.
- A preview of a fork's pull request: forks never get secrets.
