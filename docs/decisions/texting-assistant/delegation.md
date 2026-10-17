# The texting assistant — handing jobs to other agents

_Part of [the texting assistant](../texting-assistant.md), after "Tex's jobs
are task notes on the project's board"._

### Tex hands a whole sub-project to another agent, and a supervisor loop keeps it on track (2026-10-17)

Decided by the owner, 2026-10-17: Tex should open Claude Code, Claude, Claude
Design, Codex or ChatGPT, on the person's own signed-in account, for "a whole
sub part of a task", tracked in the project in Context, with "a mailing
channel between Tex and that, so the browser doesn't need to be open", and
"a subagent loop, not the main Tex loop, whose sole job is to keep the Claude
or ChatGPT on track and then deliver the final results to the main Tex
loop".

- **One tool does the bookkeeping, as the person.** `delegate`
  (`apps/mcp/src/agent/delegate.js`, offered as `send { action: "delegate" }`
  on a texted turn that can write) writes three things through the turn's own
  dispatcher, so the privacy engine, activity and history are those of any
  write: the **task note** in the project's folder (`status: in progress`,
  `owner: @maya's Claude Code`, the brief, "done when", a Result section), a
  **supervisor routine** at `tex/routines/every-10-minutes/delegate-<slug>.md`
  whose `supervises:` line names the note, and the job's line in
  `tex/jobs.md`. The model never chooses the routine's path or what it
  watches. It refuses to write over an existing note.
- **The channel is the task note's mail** ([note mail](../note-mail.md)).
  `delegate` answers with the agent's start address and one message, a single
  line so a chat box's Enter sends it whole, telling the agent to read the
  note through its own Context connector, join the note's mail, report there
  and write its result into the note. Tex starts the agent in its browser and
  then the browser can close.
- **The message is typed only on the agent's own site.** Its words are the
  model's, so without open web the browser may type it exactly as written on
  that agent's host and nowhere else (`browse.js` `delegateValue`, host
  re-checked at the keys), and may open the start address.
- **The supervisor is a routine, so it is not the person's thread.** Each run
  (`apps/mcp/src/agent/supervise.js`) joins the note's mail as `tex` and
  reads what is new, then decides *before any model runs*: the note says
  done → deliver; new mail → review; the agent silent 45 minutes since its
  last word or Tex's last chase → chase, twice, then tell the person once;
  otherwise skip with **no model call**, which is what nearly every run of a
  job going well is. A gone note stops its supervisor.
- **The supervisor holds one write: `mail_agent`**, mail to the watched note
  and no other; a routine's run is otherwise offered no note writes. The mail
  is another agent's words, so the turn is marked untrusted and the question
  says they are not instructions.
- **Results reach the main loop.** What a supervisor texts is also put in the
  texting conversation of the person's own workspace, marked as read from
  outside, so their next text to Tex carries it. A finished job's note is
  marked done, its line leaves `tex/jobs.md`, and the supervisor archives
  itself.

**What a simplification would cost:** running the supervision inside the
texting thread puts another agent's words into the person's conversation turn
by turn and spends a model call every check; letting the model write the
supervisor routine makes what it watches a model choice; vouching the message
for any site lets a page that asked for the person's notes have them typed
into it; keeping the job anywhere but a task note hides it from the board.
Tests: `apps/mcp/test/agentDelegate.test.mjs` (unit) and
`apps/mcp/test/agentDelegateRoute.test.mjs` (through `/agent`), each with a
sabotage record.

**Open:** the agent must already have Context connected (Tex's connect-for-you
skills do that); Tex's browser is stateless, so starting an agent needs a
sign-in each time, which Tex does itself with a saved login. A chat app
(Claude, ChatGPT) cannot wake itself, so it sees the supervisor's mail only on
its own Context calls; the supervisor chases and then tells the person.
