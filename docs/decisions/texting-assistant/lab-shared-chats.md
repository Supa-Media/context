# The Lab's "Shared with devs" chats are the review-sharing yes, read only (2026-11-16)

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

**Read only.** `POST /tex-lab/sandbox` gains `shared` (the list) and `ledger { chatId, ... }` (that chat's history file,
raw, as a person's own Tex page reads theirs; `apps/mcp/src/labSandbox/shared.js`). `open { source: "shared" }` copies
the chat into a test chat so its real texts sit in the dock and ▶ plays what ran in production on the graph Tex had
then. `send`, `react`, `edit`, `unsend` and `retry` are refused on it, and no session of the person's is ever asked for:
a test turn would read the person's notes afresh, which "your texts, my replies, and anything you sent me" does not
cover. To try a change on one of their texts, a developer sends it in their own chat or Maya's. `tex_dev` has the same:
`sandbox` `shared`/`ledger`/`open`, and `chats`, `turns`, `turn`, `entries`, `moments` and `set_import` (rewritten,
never verbatim) take a shared chat's key; `node_stats` stays on the caller's own chats.

**What a simplification would cost.** Letting test texts run on a shared chat, or keeping a copy of its history past
a no, widens what the yes said. Reading the list once and caching it keeps a chat after its person said no. Each is
caught: `apps/mcp/test/labSandboxShared.test.mjs` (not listed is not there, no is gone at once, raw only, no test text
runs), `apps/mcp/test/texDev.test.mjs` (shared probes), `apps/convex/__tests__/texLabShared.test.ts` (who is listed),
`apps/mobile/__tests__/texLabShared.test.ts` and `texLabSandbox.test.ts` (the tab and the read-only composer).
