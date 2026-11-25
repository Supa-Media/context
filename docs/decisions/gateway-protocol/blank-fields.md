# A field left blank is not given

Decided 2026-11-25, after Dev2's Socials bot on Grok could not finish its setup. Grok fills every field a tool
shows it, and sends `""` (or `false` for a flag) for each one it means to leave out: `url: ""` beside its logo's
`data`, `content: ""` beside edits, `text: ""` beside a mail join, `owner: ""` and `delegate: ""` beside the one
area setting it meant to change. Each was refused, or worse, changed what the call did: the blank owner unseated
the area.

So the gateway reads a blank as absent, but only where a blank can mean nothing else:

- **A top-level argument** whose advertised type has no string in it (a list, a flag, a number, an object), or
  whose `enum` has no `""`, and the strings `mailbox`, `person_said`, `expected_etag` and `since`
  (`apps/mcp/src/tools/advertised.js` `blankIsAbsent`). A required one is left, and its schema refuses it.
- **A `write` field beside `args`**: a blank `path` or `expected_etag` names nothing, and a blank `content` does
  not replace `args.content` (`v2/actions.js` `withNote`). `content: ""` beside edits, and `section: ""`, are
  the fields left empty (`notes/writePart.js` `withoutBlankPart`).
- **Mail's own fields** (`join`, `text`, `to`, `kind`, `device`) and **search and fetch's open args**, where
  `false` is a flag left off too, except `transcript`, `messages` and `activity`, whose `false` still picks
  what is read (`v2/searchFetch.js`).
- **`set_area`'s owner and delegate**: `null` clears, as the schema says; `""` leaves them as they are.
- **An image's `url`, `data` or `sha256`** ([agent images](./agent-images.md)).

What stays as sent: a blank note body with nothing beside it (a note emptied on purpose), a blank name or path
inside an action's own args, `bot.whose: ""` (it clears who a bot belongs to), and a blank `context`,
`source_context` or `destination_context`, which is still refused: serving the connected workspace for it is the
quiet version of writing into the wrong one.

`context`, `mailbox` and `person_said` written inside `args` are lifted to the call, where routing reads them,
whichever action nests its args (`v2/translate.js` `liftAddressing`); named twice, differently, is still refused.

What would break it: stripping every blank string (that would clear nothing that is meant to be cleared, and
serve a blank context from the connected workspace), or reading blanks in one tool's handler instead of at the
argument boundary. `apps/mcp/test/blankFields.test.mjs` and `setArea.test.mjs` fail if it is reversed.
