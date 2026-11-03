# No proposals

Decided by the owner on 2026-11-03 ("let's get rid of proposals entirely"). A
proposal was a note queued under `.context/proposals/` for a folder the caller
could not write, until an owner approved it: the tools `propose_note`,
`list_proposals`, `read_proposal` and `review_proposal`, the v2 actions `write
propose` and `manage review_proposal`, `fetch "proposals:"`, and orient's
"pending proposals" section. The app never showed the queue, AI clients edit
notes directly, and orient listed the bucket twice on every call to count it
(about 750 ms, one of orient's two slowest parts).

What replaced each use:

- A write outside the caller's write surface is refused with the same
  permission error as before, and the error no longer points at a queue.
- `save_context` from a team connection asking for a private archive is
  refused; it never gains private write access.
- The app's own assistant (`context_console`) is offered the client's write
  tools, as a text is (the owner chose "Edit directly, like texting" the same
  day). Any other `/agent` client and a routine's own run are offered only
  reads, and the desktop's local assistant reads only.
- Proposals already stored under `.context/proposals/` are left where they
  are: nothing reads them, and Download as folders still carries them.

Bringing a queue back would mean a screen to review it; the test that fails if
a proposal tool returns is `propose_note is no longer a tool` (and its three
siblings) in `apps/mcp/test/archiveAndChatHistory.test.mjs`, and the app's
assistant losing its writes fails `the app's own assistant is offered the same
writes a text is` in `apps/mcp/test/agent.test.mjs`.
