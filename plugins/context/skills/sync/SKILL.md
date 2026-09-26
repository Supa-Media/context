---
name: sync
description: Copy what you already know about the user into their Context, adding to what other AI apps wrote before. Run when the user asks to set up, fill in, import into, or sync their Context, or right after connecting a new AI app.
disable-model-invocation: true
---

# Sync what you know into Context

Use this the first time a person connects Context, and again whenever they
connect another AI app: each app knows different things about them, and each
run adds what this one knows to what is already there.

The user may name topics after the command (for example "work people"). By
default cover their work and projects, the people they work with (names and
roles only, never contact details), and how they like to work. Cover their
personal life only if they ask for it.

## Steps

1. Call `orient` first and follow the folders it reports. Their front page
   states their own conventions; follow those over anything here.
2. Go through everything you know about each topic, not a few highlights. Plan
   one short note per project, area, person or topic, and keep going until you
   have covered all of them.
3. Before writing each one, search for a note that already covers it with
   `search_notes`, then `read_note`.
   - **Nothing covers it:** create a note with `write_note`.
   - **A note covers it:** add what it lacks with `write_note`, passing the
     `expected_etag` from `read_note`. Remove nothing, so what another app wrote
     survives.
   - **You disagree with it:** add your version as "According to <your name>:"
     under what is there, rather than replacing it, and list it in the report.
4. Say which folder each note goes in as you write it. Don't stop to ask the
   user before writing; they asked for this run.
5. Only write what you actually know. Don't touch `index.md` or `privacy.md`,
   and don't delete or move anything.
6. Finish with a note called "Sync report" in the inbox that lists what you
   added, what you updated, and any disagreements, one line each.

If no `context` MCP tools are available, tell the user to connect Context
first, for example by running `npx -y @supa-media/context install`.
