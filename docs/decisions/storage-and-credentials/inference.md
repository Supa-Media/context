# Storage and credentials: inference on note text

## Note text is read by a model in flight, and nothing of it is kept

**Decided by the owner, 2026-09-26**, with auto-organize: Premium sends note
text to Jev (TypeSafe's decision model, `typesafe/jev` on Cloudflare Workers
AI) to ask typed questions about it, and the feature is on by default for
Premium.

**Model changed by the owner, 2026-10-05:** from Jev to Clef, Cloudflare's own
decision model (`@cf/cloudflare/clef`). Same typed questions and answers, a
64K-token window, and Cloudflare states it does not read, store or train on
requests or responses (Cloudflare's Clef announcement, checked 2026-10-05).
It costs $0.24 per million input tokens against Jev's $0.042. The framework
below keeps the name "Jev" (`withJev`, `jevUsage`, the switches), because
usage rows and switches are keyed by it.

What happens to the text, in order:

1. A sweep reads notes inside the one credential barrier
   (`files.runFileOperation`), the same way every console read does.
2. The control plane posts one note's text and a few questions to the
   inference Worker's `/decide` route (`infra/transcribe-worker`). The
   Worker passes them to Workers AI and returns typed answers: a yes/no
   probability, one of the offered options, or a score. **The model cannot
   write text back.**
3. The Worker logs counts only. Workers AI retains nothing for this model
   (zero data retention: checked for Jev on 2026-09-26, and for Clef in
   Cloudflare's announcement on 2026-10-05).
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

**Owner suggestion** (the `ownerSuggest` feature, 2026-09-26) is the second
feature: when an editor opens an owner picker on a note, that one note's text
is sent with the names the picker would offer anyway, and Jev picks one or
"none of these". Nothing of it is stored; the answer is shown, and written
only if the editor picks it ([folder lists](../folder-lists.md)).

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
  (default $0.24 per million input tokens, Clef's published price; Jev's was
  $0.042). Staff read it through `admin.jevUsageReport`.
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

## "What changed" uses a writing model, and nothing it writes is trusted

**Decided by the owner, 2026-10-05:** organizing should follow what arrives
in the inbox (meetings, mail and chat days, saved AI chats) and work out what
changed: somebody left, the focus moved, a project finished. Clef cannot say
that; it only picks from options it is given. So "What changed" uses a
generative model, the cheapest capable one the owner asked for, chosen by
score rather than by name: GLM-4.7 Flash on Workers AI
(`@cf/zai-org/glm-4.7-flash`, $0.06 per million tokens in and $0.40 out, a
131K window; Cloudflare's price list, checked 2026-10-05). On the live What
changed score it answered every arrival and scored 100%; Gemma 4 26B ($0.10 /
$0.30), the first pick on price, returned unreadable answers for half of them
and scored 33%. Both run on Cloudflare's own GPUs from open weights, so no
third party sees the text, and Cloudflare states it does not train on or keep
Workers AI requests (its data-usage page, checked 2026-10-05). A model only
becomes the default by clearing the live score's bar.

What is the same as for Clef: the text goes through the inference Worker
(its `/extract` route), in flight, logged as counts only, never echoed in an
error, and every call goes through `withJev` (feature `whatChanged`: off
until its cards ship, 100 calls per workspace per day, priced from the model's
own token counts). What the feature concludes is written to the customer's
own bucket (`.context/organizer/state.json`), never to the control plane.

What is new, because a model that writes can write anything:

- **The model's answer is re-checked field by field**
  (`mcp/src/organizer/changes.js`, `readChanges`). A step may only name a note
  the map listed, only archive or set `owner`, `priority` or `status`, and only
  to a value from the lists the model was shown. A step that changes nothing
  is dropped.
- **Every change quotes the arrival, word for word, or it is dropped.** The
  quote is what a person reads before pressing Apply.
- **A change card is only ever a proposal.** The "without asking" switches
  never apply one. Mail is written by strangers, and the arrival is marked as
  data the model must not take orders from, but the guarantee is the press,
  not the prompt.
- **Each arrival is read once.** A mark in the state file moves past an
  arrival only when it and everything before it was answered.

**What a simplification would cost:** trusting a step's path or value would
let a sentence in an email archive or reassign any project; letting a card be
applied without a press would make that automatic. The tests that fail are in
`apps/convex/__tests__/organizerChanges.test.ts`; the score against the real
models is `organizerChanges.live.test.ts`, run by "Organizer Eval (live)".
