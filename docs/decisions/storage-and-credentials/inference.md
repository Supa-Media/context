# Storage and credentials: inference on note text

## Note text is read by a model in flight, and nothing of it is kept

**Decided by the owner, 2026-09-26**, with auto-organize: Premium sends note
text to Jev (TypeSafe's decision model, `typesafe/jev` on Cloudflare Workers
AI) to ask typed questions about it, and the feature is on by default for
Premium.

What happens to the text, in order:

1. A sweep reads notes inside the one credential barrier
   (`files.runFileOperation`), the same way every console read does.
2. The control plane posts one note's text and a few questions to the
   inference Worker's `/decide` route (`infra/transcribe-worker`). The
   Worker passes them to Workers AI and returns typed answers: a yes/no
   probability, one of the offered options, or a score. **Jev cannot write
   text back.**
3. The Worker logs counts only. Workers AI retains nothing for this model
   (zero data retention, checked on Cloudflare's model page on 2026-09-26).
4. What the feature concludes, which names notes, is written to the customer's
   own bucket (`.context/organizer/state.json`). The control plane keeps
   switches and counters, never a path or a title.

**Why this is not a fourth entry in non-negotiable #2.** That list names what
*holds* customer data in an account of ours. Meeting transcription already
sends audio through Workers AI in flight and is disclosed as a transient
seam, not listed as storage
([capture-and-recording](../meetings/capture-and-recording.md)). Inference
on text works the same way. If a feature ever keeps a question, an answer or
note text after the request, that is storage, and it goes in #2 by the owner's
decision first.

**What a simplification would cost:**
- Caching answers keyed by content would put note text on disk in our
  account.
- Logging a refused request's body would put it in logs.
- Letting a feature call Workers AI from its own code would get round the
  meter and the switches below.

The test that fails is `apps/convex/__tests__/jev.test.ts`, "nothing reaches
Jev except through lib/jev". It scans the control plane for the route and the
model name. `infra/transcribe-worker/src/decide.test.ts` proves no text
reaches the Worker's logs or error bodies.

Encrypted notes never reach it. The control plane holds no key, and a sweep
skips anything it reads as ciphertext. A note with `organize: off` in its
frontmatter is skipped too.

## Every use of Jev goes through Jev smarts

**Decided by the owner, 2026-09-26:** there is one framework, every feature
goes through it, and it can collect usage and cost and be switched off.

- **`withJev(ctx, { feature, workspaceId }, fn)`** in
  `apps/convex/functions/lib/jev/client.ts` is the only way to ask. It checks
  the gate, hands the feature a session or `null`, counts every request, and
  writes the counts to `jevUsage` when the callback ends, however it ends.
- **Features are registered** in `lib/jev/features.ts`, each with a label, a
  default, a per-workspace daily cap and a plan. An unregistered name does not
  typecheck and is refused by the validators.
- **Usage** is kept per day, feature and workspace: calls, failures, refusals,
  questions, estimated tokens, and estimated cost at `JEV_USD_PER_MTOK`
  (default $0.042 per million input tokens, TypeSafe's published price; output
  is free). Staff read it through `admin.jevUsageReport`.
- **Kill switches:**
  - `admin.setJevSwitch` sets a feature, or `"*"` for all of them, and a
    missing switch means the registry default;
  - `JEV_DISABLED` in the deployment environment ("all", or a comma list)
    stops features without a database write.
- **The daily cap** is enforced from the meter, so a bug in a feature cannot
  become a bill.

A feature ships with `onByDefault: false` until its screens are live.
Auto-organize shipped off in the registry until its app screens merged, then on. While a
feature is off it does not exist: `organizerAvailable` reads the switch, so
there is no notice, no sweep and no write.
