# Storage and credentials: inference on note text

## Note text is read by a model in flight, and nothing of it is kept

**Decided by the owner, 2026-09-26**, with auto-organize: Premium sends note
text to Jev (TypeSafe's decision model, `typesafe/jev` on Cloudflare Workers
AI) to ask typed questions about it, and the feature is on by default for
Premium.

**Auto-organize and What changed removed by the owner, 2026-10-17:** "remove
'app assistant' that doesnt exist right now, remove auto organize and whats
changed, all of those should be deleted and thrown away, no way to access it
in the app and not in use". Their sweeps, cards, team routing ("For your
teams"), screens, cron, Jev features (`organizer`, `whatChanged`) and the
Worker's `/extract` route are gone. What stays of this decision is the seam
itself, which the features below still use: owner suggestions and the icon
picker's suggested emoji ask Clef through `/decide`. The `organizerSettings`
table keeps its definition only until it is emptied
(`functions/retiredTables.ts`); the old `.context/organizer/state.json` in
customer buckets is the customer's and is left where it is. Usage rows under
the two feature names still read in the AI costs report, labelled as removed
(`RETIRED_JEV_FEATURE_LABELS`).

**Model changed by the owner, 2026-10-05:** from Jev to Clef, Cloudflare's own
decision model (`@cf/cloudflare/clef`). Same typed questions and answers, a
64K-token window, and Cloudflare states it does not read, store or train on
requests or responses (Cloudflare's Clef announcement, checked 2026-10-05).
It costs $0.24 per million input tokens against Jev's $0.042. The framework
below keeps the name "Jev" (`withJev`, `jevUsage`, the switches), because
usage rows and switches are keyed by it.

What happens to the text, in order:

1. A feature reads a note inside the one credential barrier
   (`files.runFileOperation`), the same way every console read does.
2. The control plane posts one note's text and a few questions to the
   inference Worker's `/decide` route (`infra/transcribe-worker`). The
   Worker passes them to Workers AI and returns typed answers: a yes/no
   probability, one of the offered options, or a score. **The model cannot
   write text back.**
3. The Worker logs counts only. Workers AI retains nothing for this model
   (zero data retention: checked for Jev on 2026-09-26, and for Clef in
   Cloudflare's announcement on 2026-10-05).
4. Anything a feature keeps that names notes is written to the customer's
   own bucket under `.context/`. The control plane keeps switches and
   counters, never a path or a title. (Owner and icon suggestions keep
   nothing: the answer is shown and dropped.)

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

**Owner suggestion** (the `ownerSuggest` feature, 2026-09-26) is the second
feature: when an editor opens an owner picker on a note, that one note's text
is sent with the names the picker would offer anyway, and Jev picks one or
"none of these". Nothing of it is stored; the answer is shown, and written
only if the editor picks it ([folder lists](../folder-lists.md)).

Encrypted notes never reach it. The control plane holds no key, and anything
read as ciphertext is skipped. A note with `organize: off` in its frontmatter
is skipped too.

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
  (default $0.24 per million input tokens, Clef's published price; Jev's was
  $0.042). Staff read it through `admin.jevUsageReport`.
- **Kill switches:**
  - `admin.setJevSwitch` sets a feature, or `"*"` for all of them, and a
    missing switch means the registry default;
  - `JEV_DISABLED` in the deployment environment ("all", or a comma list)
    stops features without a database write.
- **The daily cap** is enforced from the meter, so a bug in a feature cannot
  become a bill.

A feature ships with `onByDefault: false` until its screens are live. While a
feature is off it does not exist: no screen offers it and nothing is read.

A removed feature's name leaves `JEV_FEATURES` for `RETIRED_JEV_FEATURE_LABELS`
(`lib/jev/features.ts`): the gate and the switches refuse it, and the AI costs
report still lists its old usage rows so the features add up to the total
(`apps/convex/__tests__/aiCostsReport.test.ts`, "a removed feature's old rows
still count"; `jev.test.ts`, "auto-organize and What changed are gone from the
registry").

## "What changed" used a writing model (removed 2026-10-17)

Decided by the owner, 2026-10-05, and removed by the owner with the rest of
auto-organize on 2026-10-17 (quoted at the top of this file). It read what
arrived in the inbox with a generative model (GLM-4.7 Flash on Workers AI,
through the Worker's `/extract` route) and proposed changes as cards. The
route, the writing half of `withJev` and the feature are deleted; the Worker
answers `/extract` with a 404 (`infra/transcribe-worker/src/decide.test.ts`,
"has no /extract"). The rules it was held to stand for any feature that
brings a writing model back, and that is a new decision: re-check the model's
answer field by field, keep only changes that quote their source word for
word, never apply one without a person's press, and treat text from mail as
data, never as orders.

## Meaning fingerprints for the icon picker (`/embed`)

Added 2026-10-14 for the suggested emoji (see
[custom-emoji](../app-and-console/custom-emoji.md)). The same Worker, secret
and rules: texts in flight only, counts in the log, nothing echoed in an
error. What it is sent is narrower than `/decide`: a folder or note name's
words, or our own emoji descriptions, never a note's text, at most 32 texts of
512 characters a request. The model is search by meaning's
(`@cf/baai/bge-m3`), so its fingerprints and the product's share one meaning.
