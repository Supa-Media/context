# One list of what Tex can do, and where (2026-11-08)

The owner asked on 2026-11-08 whether Tex, asked to "connect my email to a
group chat", would do it and explain who can draft and who can send. It would
not. In a 1:1 text Tex had no tool for it and no line saying it existed; in a
group with no mail shared, its prompt said "never offer" mail while
`chat_share_mail` was on the same turn's list; and the draft-and-send rule was
told only once a mailbox was already shared. A real test group on 2026-10-31
got "I can't see anyone's mail" from Tex. The Tex Devs chat's "Tex help me set
up community compute" went the same way. Each feature had added a sentence to
the one surface it was built on, so no surface knew the whole of Tex. The
owner chose "One capability list everywhere".

**The list:** `apps/mcp/src/agent/capabilities.js`. One line per thing Tex can
do, each saying what it is in a 1:1 text, in a group chat and in a guest chat
(or that only a person's own texts have it), and who asks, drafts and
approves. `texArchitecture.js` puts it, with one line on where the turn is,
after the drawing for the front door (1:1, group and job turns), the advisor
and the reply reviewer: the same bytes every turn, so it sits in the cached
part of the prompt (about 3,300 tokens). A surface's own lines still say what
holds right here; the list is how Tex points someone to where a thing works
instead of saying it can't.

**What Tex can't do yet, and the way around it (owner, 2026-11-08):** "a list
of things Tex can't do at all, in 1:1, in groups, and for each of these things
the suggested workarounds", so Tex doesn't waste time finding out. Each line
may carry `cant: [{ where, what, workaround: { kind, text } }]`: where is
`everywhere`, `1:1`, `group` or `guest`, and the workaround's kind is an agent
prompt (paste into Claude Code or Codex on their computer), an app path, a
vault link, a handoff link or words to type. The list draws them as their own
section after what Tex can do. When a capability lands, the pull request that
adds it removes or narrows its `cant` in the same change. The thread making
setup agent-first (computers first) adds app routes to the same lines rather
than a second list.

**The rule (owner, 2026-11-08: "how are we making sure these capabilities
lists are updated as we build?"):** a pull request that adds, removes or
changes something a person can get Tex to do, or how they set it up, changes
its line in the same pull request. That includes a feature set up only in the
app with no tool yet (lending a computer to a group chat), whose line says
exactly what the person does.

**The guard:** `apps/mcp/test/capabilities.test.mjs`, in the gateway suite. It
fails when a `write`, `manage` or `send` action, a chat command
(`commandTools.js`) or a group command word (`apps/agent/src/groupWords.ts`)
is on no line; when a line names one that no longer exists; and when a line
offers in a group what a group turn never gets (`SOMEBODYS_ALONE` in
`groupTurn.js`), or says a group lacks what it has. A feature with no tool is
the rule's alone; the test cannot see it.

**What a simplification would cost:** capability sentences written per
surface drift from the tools within days, which is how Tex came to refuse
mail sharing it could do. Dropping the list from the reviewer lets a wrong "I
can't" through.
