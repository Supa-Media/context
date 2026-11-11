# Tex settings retired: people tell Tex in words

Decided by the owner (Dev2), 2026-11-11 ("also want to retire tex settings",
then "go ahead" on the plan in the group-chat architecture review). Narrows
[custom-instructions](./custom-instructions.md) and replaces what was left of
[tex-settings](./tex-settings.md).

## What went

- **The "Tex, settings" menu**, in a person's own chat and in groups
  (`apps/agent/src/texStyle.ts`, `groupSettings.ts`), and the fixed words that
  went with it: quick picks ("Tex, no emoji", "Tex, one bubble"), "Tex, undo
  the change", "Tex, clear instructions". Those words now reach the model like
  any other text, and it changes the instructions with `tex_instructions_set`
  (add, remove, replace, clear, and now undo).
- **Quick picks** in the app and on the Tex page. The control plane's catalog
  (`texInstructions.ts` `QUICK_PICKS`) stays for now, unused by any surface; the
  Tex page drops a `pick` sent by an old page rather than saving it.
- **Progress updates** as a choice (`tex_updates_set`, the menu, the app). Job
  starts are already silent (#3169, #3152). A level saved before this is still
  read and honoured; nothing can set a new one.
- **When Tex speaks up in a group**: the four levels, the 1 to 4 question on a
  chat's first tag (which held the ask up to 30 minutes), "Tex, be quiet" as a
  level, `chat_engagement_set`, and "When Tex answers" on the Tex page. Every
  group's judge is told follow-along: Tex answers what is for it and a
  follow-up to what it just said. A level saved before this is no longer read.
  The Worker's copy of the level (`gstyle`), which could disagree with the
  control plane, is no longer read either.

## What stays

- The people's own words (`instructions`), the one store for how Tex talks,
  shown and edited on the Tex page and in Settings › Tex, and changed by Tex on
  a lasting request in their own words (`consentFor`).
- "Tex, stop" / "Tex, start": the only way to silence Tex in a group, enforced
  by code.
- "Tex, share my chats with the devs": consent, answered by code, never the model.
- Check-in, quiet-hours and overnight About me switches, machines, signing Tex
  out, who approves sends.

## Why

A menu of fixed choices duplicated what the people's own words already do, and
every choice was a second copy to keep in step (the Worker's style copy was
proven to disagree with the control plane). The style question made the first
answer in a new group wait on a setup choice nobody asked for. Tex is told
what to do in words, the same way a person would be.

## What reversing it costs

Bringing back a menu or levels means a second source of truth beside the
words, and a question before the first answer. Tests that fail if it comes
back: `apps/agent/src/groupDecide.test.ts` (no style question, "Tex, settings"
reaches the model), `apps/agent/src/inboxTurn.test.ts` (no 1:1 menu),
`apps/agent/src/groupCommandWords.test.ts` (no settings or style commands),
`apps/mcp/test/agentCommandTools.test.mjs` (no updates or engagement tools,
undo on the instructions tool), `apps/mcp/test/texPageRoutes.test.mjs` (no
picks or answers on the Tex page).
