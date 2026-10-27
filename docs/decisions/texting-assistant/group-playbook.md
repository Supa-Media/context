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
- **It changes only when the tagger asks.** A write, move or archive of the
  playbook is refused unless the tagger's own words ask Tex to remember,
  learn, or always do something (`withPlaybookGate`). An email, file or page
  Tex read can't rewrite how the chat works.
- **Guest chats never read or write it**: they read only what is shared with
  the chat's group ([group-guests](./group-guests.md)).

**What a simplification would cost:** letting any turn write the playbook
lets a stranger's email plant a standing instruction for every later turn;
not reading it leaves the chat to be taught the same thing every time.
`apps/mcp/test/agentGroupPlaybook.test.mjs` fails if either is reversed.
