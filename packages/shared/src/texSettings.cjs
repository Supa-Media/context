/**
 * EVERY SETTING THAT CHANGES WHAT TEX DOES, ONCE (Dev2, 2026-11-12: "make sure that tex is privy to its settings
 * configuration and the user can make changes in the chat without having to open the UI";
 * `docs/decisions/texting-assistant/settings-by-text.md`).
 *
 * One row per setting a person would call one: what it is in a line they read, where it applies (a person's own chat
 * with Tex, a group chat, or both), and how it changes by text. `via` names the `send` action that changes it
 * (`setting` is `agent/settingsTools.js`'s own switch; the rest are the chat command, computer and vault tools), and
 * `byText: false` is a setting only the app changes, with `appPath` saying where, so Tex can say so in one line.
 *
 * Tex reads the values through `send tex_settings` (`commandTools.js` with `settingsSnapshot`), and the app's
 * settings page renders these same rows, so the chat and the page cannot drift apart. Data only: reading and changing
 * a value is the gateway's (`apps/mcp/src/agent/settingsTools.js`), never this file's.
 *
 * `apps/mcp/test/texSettings.test.mjs` fails when a row names an action Tex doesn't have, a `setting` row has no
 * handler, or a handler has no row.
 */

/** Where a setting applies: a person's own chat with Tex, and a group chat. */
const WHERE = Object.freeze(["1:1", "group"]);

const TEX_SETTINGS = Object.freeze([
  {
    key: "talk",
    label: "How Tex talks",
    description: "Your own words for how Tex writes to you, like \"no emoji\" or \"shorter answers\"; in a group, the chat's.",
    section: "Tex",
    where: ["1:1", "group"],
    byText: true,
    via: "tex_instructions",
  },
  {
    key: "checkins",
    label: "Check-ins",
    description: "Tex looks at your mail, calendar and messages at 10, 2 and 6 and texts you only when something needs you.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "setting",
  },
  {
    key: "quiet_hours",
    label: "Quiet hours",
    description: "Hours when check-ins and your other AIs' texts wait; emergencies still come through.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "setting",
  },
  {
    key: "pings",
    label: "Texts from your other AIs",
    description: "Whether Claude Code, Codex and your other AIs can ask Tex to text you: strict, relaxed, emergencies only, or off.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "setting",
  },
  {
    key: "overnight",
    label: "Update About me overnight",
    description: "Each night Tex rewrites what it knows about you from the day's texts.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "setting",
  },
  {
    key: "tidy",
    label: "Tidy my notes",
    description: "Once a day Tex archives finished work, merges duplicates and files old inbox notes, with an undo line for each.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "setting",
  },
  {
    key: "review_sharing",
    label: "Share my chats with the Context team",
    description: "Lets the team that builds Tex read your finished conversations to improve it.",
    section: "Tex",
    where: ["1:1"],
    byText: true,
    via: "review_sharing",
  },
  {
    key: "vault",
    label: "Who can use each saved login",
    description: "Each login, key or card is yours alone, for one group chat, for everyone in a workspace, or for people you name.",
    section: "Vault",
    where: ["1:1", "group"],
    byText: true,
    via: "vault_access",
  },
  {
    key: "vault_delete",
    label: "Delete a saved login",
    description: "Removes a login, key or card for good.",
    section: "Vault",
    where: ["1:1", "group"],
    byText: false,
    appPath: "Context app → Settings → Vault",
  },
  {
    key: "computers",
    label: "Computers",
    description: "The computers Tex runs jobs on, their limits, and which group chats they are lent to.",
    section: "Tex",
    where: ["1:1", "group"],
    byText: true,
    via: "computers",
  },
  {
    key: "mute",
    label: "Tex in this chat",
    description: "\"Tex, stop\" mutes Tex in a group chat until someone says \"Tex, start\".",
    section: "Group chats",
    where: ["group"],
    byText: true,
    via: "chat_mute",
  },
  {
    key: "chat_mail",
    label: "Mail shared with this chat",
    description: "Whose Gmail this chat can read and draft from; only the mailbox's own person shares or stops it.",
    section: "Group chats",
    where: ["group"],
    byText: true,
    via: "chat_share_mail",
  },
  {
    key: "workspaces",
    label: "Workspaces Tex can see",
    description: "In a group, the shared workspaces everyone there is in; a workspace's owner can say \"share @name with everyone here\" to add the whole chat.",
    section: "Group chats",
    where: ["1:1", "group"],
    byText: true,
    via: "chat_add_everyone",
  },
  {
    key: "apps",
    label: "Apps Tex uses",
    description: "Slack, Linear and the other apps Tex acts in as you; connect one by text, disconnect it in the app.",
    section: "Tex",
    where: ["1:1"],
    byText: false,
    appPath: "Context app → Settings → Apps Tex uses → Disconnect",
  },
  {
    key: "features",
    label: "Features you're trying early",
    description: "Features turned on for you before everyone; the Context team chooses who has them.",
    section: "Tex",
    where: ["1:1"],
    byText: false,
    appPath: "Not changeable: the Context team turns these on",
  },
]);

function texSetting(key) {
  return TEX_SETTINGS.find((setting) => setting.key === key) ?? null;
}

module.exports = { TEX_SETTINGS, WHERE, texSetting };
