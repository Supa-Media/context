# A person's 1:1 Tex reads and searches the group chats they are in (2026-11-17)

**Decided by Dev2, 2026-11-17:** asked why personal Tex can't see into the group chats the person shares with it,
then: "1:1 Tex should be able to see all the groupchats i'm in (that its also connected to) and it should be able to
search through any of the messages in there if prompted. For example, 'Tex can you summarize everything that happened
in Tex dev gc last week' or 'Tex i remember talking about traveling to texas in one of my groupchats earlier, which gc
and when was that?'". Chosen from the options card as "a group list plus a read tool".

## Why

Every turn's history (`chat:` and `summaries:`, [week-history](./week-history.md)) and `read_day` read the one chat
the turn answers, and a group's `earlier_chat` was never in a 1:1 turn. Nothing listed the person's groups. It was a
capability gap, not a privacy rule: a group's home is sealed from roles in `@context-lc`, and open to the chat's own
people ([chat-homes](./chat-homes.md)), which the person is. On 2026-11-16 a group sent Dev2 to his 1:1 for a save
link, and the 1:1 asked which website, because it could not see the group.

## What it is

- **Which chats:** only those the control plane names on the person's own 1:1 texting grant
  (`apps/convex/functions/lib/texIdentity/groups.ts`, through `/gateway/agent/identity` with `groups: true`): the
  chats whose `textGroups.homeUsers` hold them, the rule the Tex page and the history export use. A routine, a
  check-in, a group chat's grant and every other client are told nothing. A chat is opened by that list's key alone,
  never by a key the model wrote.
- **The list:** the front door's context module `groups` (`apps/mcp/src/agent/groupChats.js` `groupsPrompt`): each
  chat's name, its other people and a short id, sorted by name so the cached prefix holds while they talk.
- **The tool:** `group_chats`, read only: `list`; `search` {words, chat?, since?} over one chat or all of them, each
  hit with its chat, day, time and who said it, best and newest first; `summaries` {chat, from?, to?}, each day's
  summary with the call that opens it; `read` {chat, day, part?}, one day word for word, as `read_day` reads its own.
  The model holds only the six tools, so it reaches this one as `fetch {"id": "groups:<chat>", "args": {...}}` and
  `search {query, args: {groups: true}}` (`sixTools.js`); `read_day` and `read_thread` likewise as `fetch day:<day>`
  and `fetch thread:<id>`. A local tool with no route there is never called: in the first Lab test Tex said it had no
  group tool, and no live turn had ever called `read_day` (`groupChats.test.mjs` "the model reaches every chat reader").
- **Read only.** Nothing here writes to a group, and a group's turn never gets the tool. Asking another chat's Tex to
  do something is its own design (thread "Design Tex-to-Tex messaging between chats").
- **Untrusted from the first read.** Other people's words reach the turn, so a read marks it untrusted, as a read
  email does (`privacy/egress.js`).
- **Logged like any tool.** The call and its answer are kept in the 1:1's ledger, as every step is: the person was in
  the chat and saw those words, and could already download that chat's history.
- **Shipped on the shelf.** The code is on main with the module off; a Lab draft adds `groups` to the front door's
  `ctx` and Promote turns it on (the node-shelf rule, [config-graph](./config-graph.md)).

## What a simplification would cost

- Opening a chat by whatever key the model writes: a 1:1 reads any group in Tex's store
  (`apps/mcp/test/groupChats.test.mjs` "a chat is opened only by the list's own keys").
- Listing groups for any Tex client, or by the workspace the gateway names: a routine or another person's token lists
  someone's chats (`apps/convex/__tests__/texIdentity.test.ts` "only the 1:1 texting grant asks", "one person's
  token never lists another's groups").
- Skipping the untrusted mark: a group member's words could steer a 1:1 turn's sends unchecked ("reading another
  chat's words marks the turn untrusted").
