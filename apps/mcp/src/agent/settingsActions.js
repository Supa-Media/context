/**
 * The `send` actions `settingsTools.js` is shown as (`sixTools.js`), kept apart from the tools themselves so the
 * six tools' table imports no note reading (the Tex page's `notes.js` imports back into the agent).
 */

export const SETTINGS_SEND_ACTIONS = {
  setting: { tool: "tex_setting_set", summary: "Change one of their own Tex settings: check-ins, quiet hours, texts from their other AIs, the overnight About me rewrite, the daily tidy." },
  vault_access: { tool: "vault_access", summary: "Who can use each saved login, key or card, and give it to this chat, the workspace or a person, take it back, or cut AIs off." },
};
