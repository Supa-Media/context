# The texting assistant — the Tex page

_Part of [the texting assistant](../texting-assistant.md), after "Tex's computer"._

### The Tex page shows each chat's Tex live, from the chat's own box (2026-11-02)

Decided by the owner, 2026-11-02 ("build this end to end"; "make sure that
there is some kind of WebSocket connection to the box so that it gets
real-time updates"). `context.lc/tex/@handle` becomes the person's look at
Tex: what it is working on, what it thought, what it asked, what it emailed,
its routines, check-ins, what it knows and how it talks, for "Just you" and
each group chat they are in.

- **Who may.** As `/tex/computer`: the console's own client only, the
  caller's own handle only. A group is one the person is in now, answered by
  the control plane off their live grant (`/gateway/tex/page`, the chat's
  `homeUsers`); a key they are not in is refused exactly as a key that names
  nothing (`404 not_found`). Proven in `apps/mcp/test/texPageRoutes.test.mjs`.
- **One way in for each thing.** Jobs from the chat's inbox in the texting
  Worker (`TexRoutines.pageJobs` / `pageSteer`; a steer reaches only a job that
  inbox lists). Routines, check-ins and About through the tool door every
  client's call goes through (`callToolForSession`), so a workspace kept in
  its object and one still in its bucket are read and written the same way,
  each at its own speed, with the etag passed back on every write. Settings
  through the control plane, with the rules the texted commands use. What Tex
  thought, asked the advisor and emailed are views of the chat's one log
  (decided by the owner the same day: one JSON log per chat in its Tex object,
  everything else rebuilt from it); there is no page store of them
  (`texStore/pageViews.js`: a turn is the entries sharing its `turn`, and what
  it answered is the texts its own texts name in `covers`; the log is `texts`
  for a person's chat and the group key for a group's).
- **Live from the box.** The page's socket (`GET /tex/page/live`, token as a
  subprotocol) is held by the chat's own Tex object (`person:<workspaceId>`,
  `chat:<groupKey>`), which pushes a patch when a note in it is written, when
  its log changes, and when the gateway pokes it after a page act or a texted
  settings change; while a page is open it polls the chat's jobs (2 s while one
  runs, 15 s otherwise) and pushes the job parts with their values. A socket
  lives five minutes at most, then comes back through the gateway's checks.
- **Cost of a "simplification".** Answering the page from the request's
  own handle or chat key, instead of the live grant's chats, lets anyone with
  a console grant read another group's Tex; serving the socket from the
  gateway rather than the box loses the updates made inside the box.

### The page in the app is built to the approved mock (2026-11-02)

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

### "What I'm working on" opens the Tex page, at an address per chat (2026-11-03)

Decided by the owner, 2026-11-03: "when Tex sends a link to what it's
working on, it should show the hubs context.lc/tex/@user or
context.lc/tex/group/group-id-words, both authenticated pages ofc, … instead
of random thread pages, and maybe link to sub pages".

- **The link is the hub, not a bearer view.** When an answer offers the live
  view (`[card threads]`), the gateway names the chat's Tex page beside it
  (`hub`, `apps/mcp/src/agent/hubLinks.js`): `/tex/@<handle>` for a person's
  own chat, the handle read off the grant, and `/tex/group/<words>` for a
  group, the words of the chat's home (`tex/groups/<words>`) as its own grant
  opened it. The texting Worker reads it strictly (`apps/agent/src/jobs.ts`
  `readHub`: https, one of those two paths, nothing else) and sends it as the
  card's address where cards go, and as words everywhere else, which on
  Sendblue go tappable with any picture sent beside them (`linkPreviews.ts`).
  The words are short ("Watch it live at <link> while I work.", the link
  mid-sentence, where Messages never splits it off) and ride inside the answer's
  first text rather than a bubble of their own (the owner, the same day:
  "shorter link, and put it in the first text"; `jobs.ts` `withViewLine`),
  never inside an ask that has to go exactly as written.
  A chat with neither (no handle, no home) keeps the six-hour view of
  2026-10-29 (`background-jobs.md`), so no answer loses its link.
- **Every place on the page has a path.** `/tex/@<handle>[/<view>|/job/<id>]`
  and `/tex/group/<words>[/<view>|/job/<id>]` (`features/tex/page/texPlace.ts`),
  with `?full=1` for the full-screen computer. Moving around the page writes
  these paths; the older `?chat=&view=&job=` query is still read, so links
  texted before keep working. A handoff texts `/tex/@<handle>?view=computer`.
- **A group's address grants nothing.** The words only find a chat among the
  ones the gateway already lists for the signed-in person (`pickerOf`, off
  their live grant); words that name none of theirs show the same page as
  words that name nothing, and the gateway still refuses a chat they are not
  in. The words are a locator, so telemetry folds them as it folds a handle
  (`features/observability/privacy.ts`).
- **Cost of a "simplification".** Taking the hub from the request, or not
  reading it strictly in the Worker, lets a turn's answer put any address in
  a text under Tex's name; resolving a group from its words anywhere but the
  person's own chat list would make the words a key.

Tests: `apps/mcp/test/agentHubLinks.test.mjs`, the hub check in
`agentGroupTurn.test.mjs`, `apps/agent/src/threadsView.test.ts`,
`apps/mobile/__tests__/texPageAddress.test.ts` and the address checks in
`texPage.test.ts` and `texComputer.test.ts`.

## The page loads fast (decided by the owner, 2026-11-04)

"Make the hub page load fast": it took a picture of Tex's browser on every
load and read its parts one after another. Now:

- **The browser tile asks a cheap question.** `/view/status` in site-shots
  (`infra/site-shots/src/viewStatus.ts`) asks Browserbase which browsers are
  running and what page the owner's is on, over HTTP. It never connects to the
  browser, never takes a picture (0.6 to 3 s in the week before), and never
  touches the idle timer, so opening the page no longer keeps a browser awake.
  The frame route stays for the computer page itself.
- **The first screen and the tiles are read side by side.** The app asks the
  overview in parts (`OverviewPart`: `core`, `tiles`, `chats`), draws the
  first screen when `core` lands, and fills each tile's line in when `tiles`
  lands; until then a quiet bar sits in a line of fixed height, and after four
  seconds the tile shows its title alone, never an error. A group address
  looks its chat up with `chats` only, not a whole page, and the person's
  machine asks are read beside the page, not after it.
- **Coming back is instant.** The last page each chat drew is kept in memory
  (`texPageMemory.ts`), drawn at once and read again behind it, and forgotten
  beside every clear of the device's copy (`offline/forget.ts`). Tex's
  computer is never drawn from it: whether a browser is open goes stale in
  seconds.
- **Cost of a "simplification".** Going back to the frame for the tile puts a
  browser connection and a picture on every page load and keeps idle browsers
  billing; one overview read for everything makes the page as slow as its
  slowest tile; keeping the copy past sign-out draws one session's page in
  the next.

Tests: `infra/site-shots/src/viewStatus.test.ts`, the path check in
`apps/mcp/test/texPageComputer.test.mjs`, `apps/mobile/__tests__/texPageFast.test.ts`.

## Tex knows its page (decided by the owner, 2026-11-04)

"It should know what is in the hub page so if someone asks, what are you
working on? or do you have our conversation history, or what do you know
about me, or connecting a new computer, or what settings are available etc,
tex can offer the hub link." A chat's turn is told its page's address and
every place on it, each with its own path (`hubPrompt`,
`apps/mcp/src/agent/hubLinks.js`), built from `chatHubUrl` like the card's
link, never from the request. A group is told its group page; connecting a
computer is each person's own page, so a group's words name no one's. "What
are you working on" keeps its card, which already carries the page. A chat
with no page (no handle, no home) is told nothing.

Tests: the `hubPrompt` check in `apps/mcp/test/agentHubLinks.test.mjs` and
the told-its-page check in `agentGroupTurn.test.mjs`.
