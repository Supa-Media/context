---
name: context
description: Use whenever the user asks about their own work, projects, decisions, people, preferences or past sessions, and before ending any session that produced something worth keeping. The user's Context is their own notes, reached through the `context` MCP server; this skill says when to read it and how to write back.
---

# Context

The user keeps their notes in Context, in storage they own, and this session
can reach them through the `context` MCP server. Assume the answer to anything
about them is already written down there, and look before asking them to
repeat it.

## At the start: call `orient`

Call the `orient` tool once, before your first real answer. It returns their
front page (`index.md`), what they touched recently, and a map of the folders
this connection can see. Their front page states their own conventions; follow
those over anything here.

To look something up after that, use `search_notes`, then `read_note` on the
paths it returns.

## While working: write back

- Improve the note that already covers a topic with `write_note` rather than
  adding a near-duplicate. Pass the `expected_etag` you got from `read_note`, so
  a concurrent edit is refused instead of overwritten.
- Before creating a note, tell the user which folder it will land in and wait
  for their go. The folder decides who else can read it.

## At the end: `save_context`

Before the session ends, call `save_context` with the decisions, constraints and
preferences that came out of it: anything the user should never have to say
twice. Save user-visible messages only, never system prompts, internal
reasoning, credentials or raw tool output.

## Rules the tools cannot teach you in time

1. **Their folders are theirs.** Do not assume a layout. `orient` reports the
   real one; where it is silent, ask.
2. **Notes you cannot see do not exist.** Never speculate about what this
   connection is not shown.
3. **Frontmatter is not access control.** Set visibility with the `visibility`
   argument, which is `private` or `team`. Publishing a private note to team
   needs the user's explicit yes.
4. **Never replace `index.md` wholesale.** It is the user's front page. Read it,
   pass its etag, and add to it.

## When the `context` tools are missing

If no `context` MCP tools are available, the server is not connected or not
signed in. Tell the user to run:

```sh
npx -y @supa-media/context install
```
