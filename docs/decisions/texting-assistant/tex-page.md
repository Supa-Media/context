# The texting assistant — the Tex page

_Part of [the texting assistant](../texting-assistant.md), after "The person
views and drives Tex's computer at context.lc/tex/<handle>"
([computer](./computer.md))._

### context.lc/tex/<handle> is the person's whole Tex page (Dev2, 2026-11-02)

Decided by the owner, 2026-11-02, from the approved mock (v18) after
asking for "What Tex is working on" to be redesigned: the address that only
showed Tex's browser becomes the person's Tex page, signed in, their own
handle only, in Context's paper and ink.

- **What it shows, per chat.** The person's own chat ("Just you") or any group
  chat they are a live member of, picked in the header; the whole page
  switches. Under the calm # Tex: how many jobs run and how many need the
  person; five shortcuts (Routines, Check-ins, About you or About the group,
  Tex's computer, Settings or Group settings), each its own view; Tex's
  thinking (the last three texts: who said what, the one-line thought, what
  Tex did with links to the Advisor, a Minion's job or the Email check, the
  reply, the time it took); three Minion slots (a running job each, or
  Free); jobs finished earlier; and Behind the scenes (the Advisor's asks and
  the Email check's verdicts). No model names, ever.
- **Detail only on tap.** A job opens its own view: steps, each failed step's
  reason with "Send to devs", a live look at Tex's browser while it runs,
  and a line to steer it or Stop. Routines are switched off or removed here,
  never added (that is texting Tex); check-ins are edited, cancelled and
  added; a line of About is fixed or removed; Tex settings are the same
  choices as Settings › Tex.
- **The address keeps the place**: `?chat=&view=&job=`, so back and reload
  work and a link can open any view. A handoff texts `?view=computer`, the
  browser one tap from taking over; `&full=1` is the full-screen remote
  screen the page used to be.
- **Live.** One socket per open page (`/tex/page/live`, the console grant as
  a subprotocol as `/presence/tree` does) pushes a patch whenever anything
  the page shows changes, a change somebody else makes in a group included;
  while it is down the page re-reads every 30 s when visible. Every write
  goes through `/tex/page/act`, to the same owner and storage entry point the
  text path uses, never a page-only copy.
- **Empty is not an error.** A section whose records do not exist yet draws
  as empty; a chat that is not the person's answers exactly as a missing one
  does, and the page shows nothing of it.

The app half is `apps/mobile/features/tex/page/` (contract types in
`texPageTypes.ts`, every answer read field by field in `texPageRead.ts`).
Tests: `apps/mobile/__tests__/texPage.test.ts` and `texPageRender.test.ts`
(a change made elsewhere arriving on an open page, a group that is not the
person's showing nothing). The mock's example data is fixture-only
(`/e2e-fixture?screen=tex-page`, an export flag no real build sets).
