# Photon line: Stable, with an always-on listener (2026-11-14)

Decided by Dev2, 2026-11-14 (decision card in the Photon thread): Tex's next
iMessage line is Photon's **Stable** platform (Spectrum Cloud) on a Business
dedicated line, read through an always-on listener, `infra/photon-bridge`.

## Why not the simpler shapes

- **Hosted webhooks only.** Photon's Stable webhooks deliver text, files, rich
  link URLs and tapbacks; edits, unsends, read receipts and typing are "not
  delivered in any form yet", and a delivery that fails for about 30 seconds is
  dropped with no dead-letter queue. Edits and unsends were the first thing
  asked for.
- **Photon Beta through the Vercel Chat SDK.** `@photon-ai/chat-adapter` runs
  on Beta only, where iMessage carries text and images: no tapbacks, edits,
  deletes or app cards, and cards degrade to plain text.

The gRPC event log (`@photon-ai/advanced-imessage`) has every event, each with
a sequence number and a catch-up replay. gRPC needs Node, so it runs in a
Cloudflare Container behind a Durable Object in the gateway's account (the same
shape as `infra/egress-service`). The object keeps the checkpoint per line, so
a restart replays what was missed instead of losing it.

## The shape

- Bridge → agent: RPC on the agent's named entrypoint `PhotonEvents`
  (`apps/agent/src/photonEvents.ts`), over a service binding. No URL reaches it,
  so no secret guards it.
- Agent → bridge: the `PHOTON` service binding; the bridge has no public route
  (`workers_dev: false`).
- Tex's `Line` / `GroupLine` stay the one provider seam. A Photon chat is
  `photon:<line>:<phone>`, a group `photon-group:<base64url(chat guid)>`.
- Pictures out are sent as real attachments (the bridge fetches Tex's hosted
  address and uploads the bytes); plain links go with iMessage's own rich link
  preview, so none of Sendblue's picture-before-link workarounds run on Photon.
- Pictures in are served to the gateway at a signed address on the agent
  (`/photon/attachment/<guid>?e=&s=`) that expires after 7 days.
- The only credentials are `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`,
  on the bridge alone. Unset, the bridge deploys idle.

## What a simplification would cost

Replacing the listener with webhooks loses edits, unsends and read receipts and
makes intake lossy across an outage. Replacing `Line` with the Chat SDK loses
app cards, carousels, contact cards and threaded replies. Tests:
`apps/agent/src/photon*.test.ts`, `infra/photon-bridge/test/*.test.mjs`.

Not decided yet: what Tex does when a text it has not answered is edited or
unsent (they are counted and logged for now), and the cutover date for the old
Sendblue number (`texOldLine`, staff console → Platform → Lines).

## Tex's number has one home (2026-11-16)

Dev2 saw the old Sendblue number in Settings after the move: every screen that
names Tex's number (Settings, the /tex pages, the waitlist's "You're in", the
staff console) read `TEX_LINE_NUMBERS`, which still listed the Sendblue line,
while the Photon number was typed separately in the Lab. Now the number people
are told is `TEX_NUMBER` in `packages/shared/src/texNumber.cjs` and nowhere
else; the control plane serves it (`texNumberHere`), so phones follow without
an app update. `TEX_LINE_NUMBERS` only lists the lines Tex still answers on
and says that this deployment runs Tex; it is never shown. Moving Tex to
another line is a change to `TEX_NUMBER`. A simplification back to showing
`TEX_LINE_NUMBERS` fails `apps/convex/__tests__/texHome.test.ts` and
`texAllowlist.test.ts` ("never one of the lines Tex still answers on").

## The bridge is healthy only when it has read Photon (2026-11-17)

`bridge.health` used to say ok whenever the container process answered. On
2026-11-17 from 12:43 to 12:48 PM ET it said ok, queued 0, while Photon reads
had already stopped; the minute alarm never noticed. A read older than two
poll intervals (two minutes) is degraded and is not logged as ok. No
successful read for three minutes, while the container claims to be up, is
stale: the object restarts the container. A missing instance (`no container
instance`, which also showed up as `wake.failed` after the 12:48 deploy)
retries the wake on a short backoff and pulls the next alarm forward to a
few seconds, instead of waiting out the minute.

The Photon secrets are uploaded with the Worker (`wrangler deploy
--secrets-file`), one version and one container start. A later `wrangler
secret put` publishes a second version. That second start, eighteen seconds
after the code upload, is what left the object with no container instance.

The first read after a container start logs how many events catch-up
replayed and how old the oldest was, so a late burst can be split between
Photon and the bridge.

A simplification that treats "the process answered `/health`" as healthy, or
that puts the secrets in a later secret put, fails
`infra/photon-bridge/src/readHealth.test.ts`,
`infra/photon-bridge/src/wake.test.ts`, and
`scripts/photon-secrets-file.test.mjs`.
