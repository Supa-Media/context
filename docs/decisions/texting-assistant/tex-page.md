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
