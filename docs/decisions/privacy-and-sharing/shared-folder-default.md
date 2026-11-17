# Privacy and sharing — a new note in a shared workspace takes its folder's default

### A new note in a shared workspace takes its folder's default (decided by the owner, 2026-11-17)

A personal connection (an AI client, Tex) used to save every new note private unless the call asked for a
visibility: `requested || existing || scope` in `apps/mcp/src/tools/notes/write.js`, where a personal
connection's scope is `private`. In a shared workspace that put a project Tex made in a team folder out of reach
of the workspace's own members, and the person's "use the folder's default" could only be remembered as a note,
never kept.

The owner chose, from the options for that report: **in a shared workspace, a new note with no visibility asked
for takes its folder's tier.** Only `team` is taken from the folder this way; a folder whose default is private
keeps the note private, as before. A personal workspace keeps the private default. An explicit `visibility`, a
`share` and an existing note's own tier are unchanged. No `confirm_team_publish` is asked for such a note, because
nothing is published beyond what the folder already gives its members (non-negotiable #5: `team` is the
workspace's members, never the public).

What a "simplification" would cost: reading the connection's scope alone again puts every Tex-made note in a
shared workspace back to private. `apps/mcp/test/sharedFolderDefault.test.mjs` fails if the shared-workspace
default is dropped, or if it reaches a personal workspace.
