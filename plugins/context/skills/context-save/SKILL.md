---
name: context-save
description: Save what this session learned into the user's Context. Use when the user asks to save, remember, or write this session down, or runs the context-save command.
---

# Save this session to Context

1. List the durable things this session produced: decisions and why, constraints,
   preferences, names, fixes, open questions. Skip anything transient.
2. For each one that belongs in an existing note, call `search_notes`, then
   `read_note`, then `write_note` with the `expected_etag` you read. Improve that
   note; do not add a near-duplicate.
3. For anything that needs a new note, tell the user which folder it will land in
   and wait for their go before calling `write_note`.
4. Call `save_context` with the session's decisions and, if the user wants it,
   the user-visible messages. Never include system prompts, internal reasoning,
   credentials or raw tool output.
5. Tell the user what was written and where, one line per note.

If no `context` MCP tools are available, tell the user to run
`npx -y @supa-media/context install`.
