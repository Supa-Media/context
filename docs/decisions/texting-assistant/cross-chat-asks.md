# Tex asks Tex across chats, and a "Starts a new run" wire (2026-11-17)

Dev2, 2026-11-17: "design a way where 1:1 tex can message a group tex for info, and ask it to do things, and vice
versa". The design (https://claude.ai/artifact/N3ZawPjhhgYcNfHm7xWa37) was approved with every recommended choice,
and Dev2 chose to keep building it while the "friend test" judgment on top of it is designed.

**One ask is three runs, linked only by the ask's id** (the generators model, Dev2 2026-11-16: a job is not part of the
run that fired it):

1. In the asking chat the model calls `send ask_chat`. Node **Cross-chat gate** (`crossChatGate`, code) says whether it
   may go. The turn answers at once; the ask rides on the answer (`crossAsks`) to the texting Worker.
2. The Worker (`packages/tex/worker/crossChat.ts`) keeps the ask (`xask:<id>`), and queues it in the other chat's object as
   a turn of that chat's own: in a group as its asker's tag (re-checked by the control plane like any tag), in a person's
   1:1 by code. Node **Another chat asks** (`chatAsk`, an input) gives the run its fixed question, never the other
   chat's words as anyone's text. Node **Answer the other chat** (`chatAnswer`) sends its checked draft back instead of
   texting it there; a do-ask in a group may post one line, signed by code with who asked (`post_in_chat`).
3. The answer, a refusal, or "no answer in 10 minutes" starts a run in the asking chat (`chatAsk` again, kind
   `answer`), which texts the person in its own words.

**Who may ask whom.** A 1:1 asks only a group its person is in now (the `groups` list, read on their own grant). A group
asks only the personal Tex of whoever tagged it, or of somebody else there once their 👍 or yes makes it their own tag
(as `ask_personal_tex` did; it folds into `ask_chat`, `contact: true` still answering name, phone and email at once). A
group never asks another group, a guest has no Tex, and a person who never texted Tex on their own has no 1:1 to ask.
Only the answer's words cross; both runs are marked as another chat's words, off the daily cap.

**Limits.** One hop: a run an ask started has no `ask_chat`. One open ask per pair of chats; 10 an hour and 40 a day per
chat (`CROSS_CHAT_LIMITS`); a 10-minute timeout. Two of a group's turns side by side could each pass the gate before
either is counted, so the caps can be exceeded by at most the number of lanes.

**A new wire mode, `generator` ("Starts a new run").** The source starts a new run that begins at the target, an input
node; nothing in the current run waits for it, `run` never fires it, and the cycle check ignores it, so a generator may
point back up the graph (`chatAnswer -> chatAsk`). Replay shows each run in its own chat, linked by the logged ask id.

**On the shelf until promoted.** The nodes' code is merged unwired (`texNodeShelf.json`); `send ask_chat` and
`post_in_chat` join the send actions, and the capability list gets its line, in the pull request that promotes the Lab
draft wiring them, so no turn is told of a capability it can't use.

**What a simplification would cost.** Answering inside the asking turn would hold it for the other chat's whole run
and hide that run from its own chat's replay; letting an ask-run ask on would let two chats loop; texting an ask-run's
draft would put one chat's words in front of people who never asked. Tests: `apps/mcp/test/crossChat.test.mjs`,
`packages/tex/worker/crossChat.test.ts`, `apps/mcp/test/texGraph.test.mjs` (generator wires) and the replay case
`apps/mcp/test/replay/cases/routine-sees-chat.mjs` (its cross-chat part). Wired into the config by the Lab draft "Cross-chat asks" (promoted
2026-11-17); unwiring `tools -> crossChatGate` in a draft turns it all off again, and `ask_personal_tex` comes back.
