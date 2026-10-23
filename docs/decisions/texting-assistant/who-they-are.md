# Tex always knows who is texting it (2026-10-23)

Signing the owner in to Partiful, Tex texted "your number isn't anywhere in
your notes. What's the number on your Partiful account?", to the number it was
texting. A phone number, a name and an email are account facts held by the
control plane, not notes, so no search could ever find them. Decided by the
owner (Dev2), 2026-10-23: Tex always knows the texter's own phone number,
name, emails and connected accounts, and uses them for a sign-in or a form
without asking.

- **Told on every turn Tex answers for one person.** A 1:1 text, a background
  job, a routine and a check-in each ask `POST /gateway/agent/identity` with
  the person's own token (`apps/convex/functions/lib/texIdentity/identity.ts`)
  and get `{ name, handle, phones, emails, google }`: the phone they text Tex
  from first, every confirmed email and every connected Google address. The
  gateway checks and bounds each field and says them in the system prompt
  beside `tex/about-me.md` (`apps/mcp/src/agent/identity.js`), told to use
  them rather than ask; only a code a site sends is theirs to give.
- **Only Tex's one-person clients, only the grant's own person, only their
  personal workspace.** A third-party MCP client never learns a phone number
  this way, a group chat's grant (several people) learns nobody, and one
  person's token never reads another's. Every refusal is the same `null`.
- **Best effort.** A control plane that fails or predates the route is a turn
  that knows less, never one that fails.

## What else Tex was not remembering

Auditing the same day what Tex is told about a person on each turn turned up
two more gaps, fixed together:

- **Facts their other AI apps saved never reached Tex.** Claude, ChatGPT and
  every other connected client save what they learn with `remember`, and a
  fact with no note lands in its own inbox note (`inbox/memories/<day>-<slug>.md`).
  Tex read only `tex/about-me.md`, and its dream read only Tex's own
  transcripts. The nightly dream now also reads the memory notes saved since
  it last ran (all of them on a first dream) and keeps the lasting ones
  (`apps/mcp/src/agent/dreamMemories.js`); a night with only those is no
  longer a quiet night.
- **Check-ins judged what matters without knowing the person.** A check-in
  decides whether a mail or a meeting is worth a text, but was never shown
  `tex/about-me.md`. It is now, with who they are, read-only like the rest of
  its turn.

**What a simplification would cost.** Dropping the identity from the prompt
brings back "what's your number?" asked of the number being texted, and every
sign-in handed back to the person. Opening the route to any client would hand
every connected app the person's phone number. Dropping the memory notes from
the dream splits what the person told Claude from what Tex knows.

**Tests that fail if it is reversed.** `apps/convex/__tests__/texIdentity.test.ts`
(who may learn whom), `apps/mcp/test/agentIdentity.test.mjs` (a texted turn is
told the number it is texting), and `agentDream.test.mjs` ("facts their other
AI apps saved are read by the dream").
