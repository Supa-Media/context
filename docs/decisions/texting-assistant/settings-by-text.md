# Tex knows every setting, and changes it from a text (2026-11-12)

Decided by Dev2, 2026-11-12: "for vault saves, and other settings that change
the experience can you make sure that tex is privy to its settings
configuration and the user can make changes in the chat without having to open
the UI". Then: "I should be able to say share with x person as well, or share
with the workspace and it just works, fine to confirm its final action". On the
card "Can a vault login be widened to this chat or workspace by text?" Dev2
picked "Yes, on the saver's own words".

## What was wrong

`send tex_settings` read only the instructions text. Everything else a person
would call a setting was a note Tex had to know to open (`tex/heartbeat.md`,
`tex/attention.md`, `tex/dreams.md`, `tex/housekeeping.md`), a switch Tex could
set and not read back (sharing chats with the team), or app-only. After #3205
gave each saved login a "who can use it" (this chat, the workspace, only me),
Tex could not say which a login had, nor change it.

## The rule

- **One list of settings.** `packages/shared/src/texSettings.cjs`: every
  setting that changes what Tex does, one row each, with a line a person reads,
  where it applies (1:1, group), and either the `send` action that changes it or
  the app path where it changes. The app's settings page renders the same rows,
  so the chat and the page cannot drift. A new setting adds its row in the same
  pull request; `apps/mcp/test/texSettings.test.mjs` fails on a row whose action
  Tex doesn't have, and on a switch with no row.
- **`send tex_settings` reads them all**: how Tex talks, check-ins and quiet
  hours, texts from their other AIs, the overnight About me rewrite, the daily
  tidy, team sharing, early features, the workspaces they reach, and each saved
  login with who can use it; in a group, the chat's instructions, whose mail is
  shared there, the workspaces it reaches and the logins that work there. On
  demand, not in every prompt.
- **`send setting` changes the 1:1 switches** in the person's own `tex/` notes,
  the same front matter keys the Tex page writes.
- **`send vault_access` changes who has a login**: give it to this chat, the
  whole workspace or a member by @handle, take it back, keep it to its saver, or
  cut every AI off it. Only whoever saved it, through their own texting grant or
  their own tag in a group chat (`ownTagOf`); a widening runs only when their own
  words ask for it (the judge every widening uses). People given a login use it
  through their AIs and never see the password. Tex says back who has it now.
- Still app-only, each named on its row: deleting a saved login, cutting off one
  particular AI, disconnecting an app, and early features (the Context team's).

## Cost of reversing it

Settings scattered across tools drift: Tex says "saved" for a change it can't
make, or sends people to a page for a switch it holds. The tests above, and
`apps/convex/__tests__/vaultByText.test.ts` (only the saver, only on their own
tag, never another workspace), fail first.
