# Tex's chat commands are tools the agent calls (2026-10-31)

Decided by Jhonatan, 2026-10-31, part of the new architecture
(`@supa projects/tex/new-architecture.md`).

In the Tex Devs group, "Tex settings" worked only as an exact phrase, and
"Tex why don't you listen to settings" got the answer that Tex had "saved the
style settings". It could not have: the turn had no way to change them, so it
wrote a note and called that saving. Rules about what a chat can change lived
in regex in the texting Worker, and the model had no say and no tools.

## The rule

- **Changing how Tex acts in a chat is a tool.** The interaction agent holds
  `tex_settings_get`, `tex_style_set`, `chat_engagement_set`, `chat_mute`,
  `chat_status`, `chat_share_mail`, `chat_unshare_mail` in a group, and
  `tex_settings_get`, `tex_style_set`, `review_sharing_set` in a person's own
  chat (`apps/mcp/src/agent/commandTools.js`), shown as `send` actions
  (`sixTools.js`). Any wording works. Each answer says what happened, and a
  refusal is never worded as done.
- **The grant decides who acts, never the arguments.** A tool posts
  `/gateway/tex/command` with the turn's own access token
  (`functions/texCommands.ts`). The chat and the person come off the live grant.
- **One executor.** The tools and the Worker's exact commands call the same
  rules (`functions/lib/texChatRules.ts`, `lib/textGroupMail.ts`,
  `texReviews.ts` `setSharing`): anyone in the chat mutes Tex and sets the
  style and when it speaks up; only the mailbox's own person shares or stops
  sharing their mail, in a chat on a shared workspace they can edit; a person's
  review sharing is set in their own chat only.
- **Acting for the person needs their own words.** Sharing or unsharing
  their mail and their review sharing run only when the turn's own message,
  from the person the grant names, asks for it (`commandTools.js`
  `consentFor`): a code check that the words name it, then the same small
  judge as any widening (`privacy/judge.js`) where the deployment has one.
  Those words are the Worker's `question`, never the model's arguments, so
  another member's text, a quoted message or an email cannot make the turn
  act as the tagger (security review, 2026-10-31). Otherwise the tool says
  they have to ask in their own words.
- **Guests get mute, settings and style only.** A guest's tag, and an invited
  person's, is minted on the account of whoever opened the chat, so nothing
  that acts as a person (mail, review sharing) is theirs.
- **The exact short commands stay in code.** "Tex, settings", "Tex settings",
  "Tex, stop", "Tex, start", "Tex, use @x" and replies to the menu are still
  answered at once by the Worker, beside a running turn too
  (`groupBeside.ts`, the four-minute fix of 2026-10-30), and in muted or
  unbound chats, which have no turn to call a tool from.
- **Choosing a workspace, inviting everyone and starting a muted Tex are not
  tools yet.** They need the chat's member list, which only the Worker holds,
  and a muted chat's grant does not resolve.
- **The prompt says it.** Every texted turn is told settings change only
  through the `tex_style` action, a note is never the settings, and it says
  only what a tool's answer says happened (`chatVoice.js` `SETTINGS_LINE`).
  The voice note says it is not the settings.
- **A message for another assistant is not Tex's.** Named to another assistant
  or bot (Instinct is in Tex Devs), and not to Tex: decide is told silent,
  never a react (`textDecide.ts` `OTHER_ASSISTANT_RULE`), and so is the agent.

## What a simplification would cost

Reading the person or chat from the tool's arguments lets any turn act as
anyone ("the chat and person come off the grant" in `texCommands.test.ts`
fails). Giving a guest's tag the mail tools lets a guest share the opener's
mail ("a guest may mute and set the style" fails, and its gateway twin in
`agentCommandTools.test.mjs`). Letting the Worker's command write the style
its own way lets the two paths drift ("the tool and the texted command write
the same row" fails). Dropping the own-words check lets another member, a quote or an email share the tagger's mail ("another member's words, a quote or an email cannot share Ada's mail" fails). Wording a refusal as success brings back "I've saved
your settings" ("a refusal is never worded as done" fails).
