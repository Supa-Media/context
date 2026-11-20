# The Lab's "Shared with devs" chats are the review-sharing yes, tested as their person in a sandbox (2026-11-16)

Dev2, 2026-11-16: "We need an easy, reliable way ... for someone to share their chat history and future chat with
developers. So I should be able to then go to the Lab and see a new category of like shared with developers and sort
of click through histories and see and replay things and debug issues."

**One yes, not two.** The switch already existed: Settings → Feedback "Share finished Tex conversations", and texting
Tex "share my chats with the devs" (`texReviews.ts` `texReviewSharing`, [self-review](./self-review.md)). Its words to
the person are that the team "can read the whole thing: your texts, my replies, and anything you sent me in it". The
Lab tab reads that same row; there is no second consent and no second table. Turning it off deletes the row, and the
chat is gone from the Lab on the next call: past and future texts alike, since nothing is copied out.

**Who is listed** (`apps/convex/functions/lib/texLabShared.ts` `sharedChats`, asked on every call):

- a person's 1:1 while they say yes;
- a group chat only when everybody in it said yes or is on the team, and at least one said yes: the rule self-review
  already keeps a group's words by (`reviewSetup`). One person who has not said yes keeps the whole chat out;
- never the caller's own chats, which are under "Your account".

Who may read the list is the Lab's test chats' rule unchanged (staff who own or edit the pinned context;
`texLabSandbox.ts` `sandboxCaller`, `texLabDrafts.ts` `texDeveloper` for `tex_dev`).

**Browse, replay, and test as the person.** `POST /tex-lab/sandbox` gains `shared` (the list) and
`ledger { chatId, ... }` (that chat's history file, raw only, as a person's own Tex page reads theirs;
`packages/lab/gateway/labSandbox/shared.js`). `open { source: "shared" }` copies the chat into a test chat: its real texts sit
in the dock, ▶ plays what ran in production on the graph Tex had then, and ⑂ "Sandbox from here" works as on the
developer's own chats. A test text there runs on the sharer's own session (`texLabSandbox.ts` `sharedSessionFor`: a
1:1 as its person, a group as one of its people with a live grant, the sponsor first), so Tex reads their notes live
as it would for them, and every write stays in the sandbox as in any test chat. The session is asked for again on
every text, and only while the chat is listed, so a no stops test texts at once.

**Without the sharer's notes (Dev2, 2026-11-17).** Reading them live never worked reliably: the store asks for the
workspace's key with the developer's token, and a workspace's key is handed only to its members, so a test text in
Sayo's shared 1:1 stalled before Tex ran whenever no copy was kept. Dev2 chose to run shared test texts without the
sharer's notes rather than hand developers that key: a shared chat's test turn gets an empty store of its own
(`apps/mcp/src/labSandbox/policy.js` `NO_NOTES_BINDING`), every read empty and no save kept. A shared 1:1 lists only
the group chats that are shared with the developers too, for a 1:1 that reads its groups
([group-reads-from-1to1](./group-reads-from-1to1.md); `sharedSessionFor`).

**Mail, calendar and chat stay empty too (2026-11-17).** That notes store was the only read answered locally. The
session on a shared test turn is still the sharer's, and the gateway still keeps the caller's token (`texLabSandbox.ts`:
"Never a token: the gateway keeps the caller's"). Mail, calendar and Google Chat reads were still sent, and so were
the other personal-account reads on that same path: mailbox health and note-mail lookups, connected apps, the
connect-Google page, share links, member profiles (name and email), the caller's identity aside from the shared-group
list, a vault list, the caller's computers, and transcription consent. The control plane would have answered each for
whichever of the two people that token and workspace resolved to. With `gate.noNotes`, `controlPlaneAnswer` answers
them empty (`emptyPersonalRead`) and does not send them. The developer's own test chat is unchanged, and those reads
still go through there. `tex_dev` `sandbox` uses the same gate.

Dev2 chose this on 2026-11-16 ("Allow test texts", over a read-only Lab tab), with the yes's wording updated to say
so for everyone who says yes from then on: Settings → Feedback and Tex's texted answer (`packages/tex/worker/
reviewSharing.ts` `WHAT_IT_MEANS`) say the team can "text a test copy of the chat, where I answer as I would you,
reading the notes I can read; nothing done there changes your notes or reaches anyone".

`tex_dev` has the same: `sandbox` `shared`/`ledger`/`open`, and `chats`, `turns`, `turn`, `entries`, `moments` and
`set_import` (rewritten, never verbatim) take a shared chat's key; `node_stats` stays on the caller's own chats.

**What a simplification would cost.** Keeping a copy of a shared history past a no, or a test session handed out
without asking the list, widens what the yes said. Reading the list once and caching it keeps a chat after its person
said no. Running a shared chat's test text on the developer's session reads the wrong person's notes. Sending a shared
chat's mail, calendar or Google Chat read (or the other personal-account reads beside them) reads one of the two
people's data. Each is caught:
`apps/mcp/test/labSandboxShared.test.mjs` (not listed is not there, no is gone at once for reads and test texts, raw
only, the sharer's session), `apps/mcp/test/labSandbox.test.mjs` (a shared chat's mail, calendar, Google Chat and the
other personal-account reads come back empty and are never sent), `apps/mcp/test/texDev.test.mjs` (shared probes), `apps/convex/__tests__/texLabShared.test.ts`
(who is listed, the sharer's session only while listed), `apps/mobile/__tests__/texLabShared.test.ts` and
`texLabSandbox.test.ts` (the tab).
