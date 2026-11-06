# A workspace keeps one playbook its group chats follow (2026-10-27)

The owner wants Tex in their family business's chat to learn how the business
works: "this is what you should do when you see this", "this is how you send
emails", "these are the clients we're dealing with". A person's learned
skills (`learned-skills.md`) live in their personal workspace and a group
turn reads none of them, so a chat had nowhere to keep what it was taught.
Chosen with the rest of the owner's defaults on 2026-10-27.

## How it works

- **One note per workspace, `tex/groups/playbook.md`**, beside the chats'
  memory notes. That folder is shared with the workspace the first time a
  chat writes there (`groupMemoryNote.js`), so everyone in the workspace can
  read and fix the playbook in the app.
- **Every group turn reads it** (`groupPlaybook.js` `readPlaybook`, up to
  12,000 characters) and is told to follow it where it applies. It is the
  workspace's own notes: it never makes an address, a recipient or a payment
  the person's word.
- **Tex decides when it changes, never after reading from outside the chat**
  (the owner, 2026-11-05: "we should let the advisor choose to create new
  memories"). Until then a word list of teaching phrases decided, and it
  refused "Tex store this in your memories" in Tex Devs. Now the prompt tells
  Tex to keep a rule when someone asks it to remember, store or learn
  something, or says how a job is done from now on, and to leave out one-off
  asks. A write, move or archive of the playbook is refused only on a turn
  that read something from outside the chat this turn, an email, a page or a
  file (`withPlaybookGate`, `ledger.outside`, as for a chat's skills), so an
  email can't rewrite how the chat works.
- **Guest chats never read or write it**: they read only what is shared with
  the chat's group ([group-guests](./group-guests.md)).

**What a simplification would cost:** dropping the outside check lets a
stranger's email plant a standing instruction for every later turn; bringing
back a word list refuses the plain ways people ask Tex to keep something;
not reading it leaves the chat to be taught the same thing every time.
`apps/mcp/test/agentGroupPlaybook.test.mjs` fails if either is reversed.
