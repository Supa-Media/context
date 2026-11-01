/**
 * TEX'S CHAT COMMANDS AS TOOLS (Dev2, 2026-10-31;
 * `docs/decisions/texting-assistant/command-tools.md`).
 *
 * "Tex, settings" worked only as an exact phrase, and a turn asked to change
 * the settings any other way wrote a note and said the settings were saved,
 * which it could not do. These tools are the only way a turn changes how Tex
 * acts in a chat, and each answer says what actually happened, so the turn can
 * say only that.
 *
 * Every call goes to the control plane with the turn's own grant
 * (`/gateway/tex/command`, `functions/texCommands.ts`). The chat and the person
 * acting come off that grant, never from these arguments, and the rules are
 * the ones the texting Worker's exact commands use, so the tool and the texted
 * command cannot behave differently. A guest's tag gets only mute, the
 * settings and the style; a person's own chat gets their own settings and
 * review sharing.
 *
 * The tools that act for the person or widen who sees something (sharing or
 * unsharing their mail, their review sharing) run only when the turn's own
 * message, from the person the grant names, asks for it (`consentFor`). Those
 * words come from the texting Worker (`body.question`, the tagger's own
 * message), never from the model's arguments, so another member's text, a
 * quoted message or an email's contents cannot steer the turn into acting as
 * the tagger. The same small judge as any other widening decides when the
 * deployment has one (`privacy/judge.js`), after a code check that the words
 * name the thing at all.
 *
 * Choosing a workspace for a chat, inviting everyone in it and starting a
 * muted Tex stay with the texting Worker's commands ("Tex, use @x",
 * "Tex, start"): they need the chat's member list, which only the Worker
 * holds, and a muted chat has no turn to call a tool from.
 */

import { judgeFor } from "../privacy/judge.js";

const STYLE_SCHEMA = {
  type: "object",
  properties: {
    tone: { type: "string", enum: ["default", "professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"] },
    warmth: { type: "string", enum: ["more", "default", "less"] },
    enthusiasm: { type: "string", enum: ["more", "default", "less"] },
    emoji: { type: "string", enum: ["more", "default", "less"] },
    length: { type: "string", enum: ["short", "default", "detailed"] },
    bubbles: { type: "string", enum: ["multiple", "one"] },
    humor: { type: "integer", minimum: 0, maximum: 100, multipleOf: 10 },
  },
};

/** What the person may set, and how a reply to the numbered menu maps to each; shown by `tex_settings_get`. */
const MENU =
  "Settings: Tone (default, professional, friendly, candid, quirky, efficient, nerdy, cynical); Warmth, Enthusiasm and Emoji (more, default, less); " +
  "Length (short, default, detailed); Bubbles (multiple, one); Humor (0 to 100% in steps of 10, default 75%).";

const REFUSALS = {
  refused: "That didn't go through: this chat's access has ended or changed. Nothing was changed; say so plainly.",
  not_allowed: "Not allowed for the person asking here, so nothing was changed. Say so plainly; never say it was done.",
  bad_request: "That value isn't one of the options, so nothing was changed. Offer the valid options.",
  mail_refused:
    "Not shared: only the mailbox's own person can share it, from a connected Gmail, in a chat on a shared workspace they can edit. Nothing was changed.",
};

/** The words a consent-gated action needs in the person's own message before the judge is even asked. */
const CONSENT_WORDS = {
  share_mail: /\b(mail|email|e-mail|inbox|gmail)\b/i,
  unshare_mail: /\b(mail|email|e-mail|inbox|gmail)\b/i,
  review_sharing: /\b(shar\w*|review\w*|conversations?|chats?)\b/i,
};
const CONSENT_ACTIONS = {
  share_mail: "share the person's own email inbox with this group chat",
  unshare_mail: "stop sharing the person's own email inbox with this group chat",
  review_sharing: "change whether the person's finished conversations are shared with the Context team",
};
export const OWN_WORDS_REFUSAL = "They have to ask for that in their own words. Nothing was changed; tell them so.";

/**
 * Whether the turn's own message (`words`, the grant's person's text from the
 * Worker, never the model's) asks for `kind`. A code check first, then the
 * judge when there is one. Anything but a clear yes is a no.
 */
export function consentFor(words, judge = null) {
  return async (kind) => {
    const said = typeof words === "string" ? words : "";
    if (!CONSENT_WORDS[kind]?.test(said)) return false;
    if (typeof judge !== "function") return true;
    try {
      return (await judge({ words: said, action: CONSENT_ACTIONS[kind] }))?.allow === true;
    } catch {
      return false;
    }
  };
}

/** `consentFor` with this deployment's judge, or the code check alone where there is none (self-hosting). */
export function consentForTurn(words, env) {
  return consentFor(words, judgeFor(env));
}

/** One tool's answer, as words the turn may repeat. Anything unexpected is a failure, never a success. */
function answered(result, success) {
  if (result && typeof result === "object" && result.status === "done") return text(success(result), false);
  const status = result && typeof result === "object" ? result.status : null;
  return text(REFUSALS[status] ?? "That couldn't be done right now. Nothing was changed; say so plainly.", true);
}

function text(words, isError) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

function styleWords(style) {
  const entries = Object.entries(style ?? {});
  if (entries.length === 0) return "every setting at its default (humor 75%)";
  return entries.map(([key, value]) => (key === "humor" ? `humor ${value}%` : `${key} ${value}`)).join(", ");
}

/**
 * The command tools a texted turn gets, each `{ tool, call }` for `runTurn`'s
 * `local` list. `run(command)` posts one command with the turn's own grant
 * and resolves to the control plane's answer (`controlPlane.texCommand`).
 *
 * `consent(kind)` resolves true only when the turn's own message asks for a
 * consent-gated action (`consentFor`); without it those actions are refused.
 *
 * @param {{ run: (command: object) => Promise<object|null>, group: object|null, consent?: (kind: string) => Promise<boolean> }} options
 */
export function commandTools({ run, group, consent = async () => false }) {
  if (typeof run !== "function") return [];
  const asked = async (kind) => {
    try {
      return (await consent(kind)) === true;
    } catch {
      return false;
    }
  };
  const call = (command, success) => async () => {
    try {
      return answered(await run(command), success);
    } catch {
      return text("That couldn't be done right now. Nothing was changed; say so plainly.", true);
    }
  };
  const settingsGet = {
    tool: {
      name: "tex_settings_get",
      description:
        "Read how Tex is set to talk in this chat, and the options a person can choose. Use it when someone asks about Tex's settings " +
        "or says \"settings\" in any wording. Show them the options in one short message. Takes no arguments.",
      inputSchema: { type: "object", properties: {} },
    },
    call: call({ kind: "settings" }, (result) => {
      const speaking = group !== null && result.engagementChosen ? ` When Tex speaks up here: ${result.engagement}.` : "";
      return `Current: ${styleWords(result.style)}.${speaking} ${MENU}`;
    }),
  };
  const styleSet = {
    tool: {
      name: "tex_style_set",
      description:
        "Change how Tex talks in this chat: pass only the settings to change; the rest stay as they are. This is the only way the settings change: " +
        "a note you write (the voice note, About me, memory) is never the settings, so never say settings were saved unless this tool says so. " +
        "Values outside the listed options are refused and change nothing.",
      inputSchema: STYLE_SCHEMA,
    },
    call: async (args) => {
      const style = {};
      for (const key of Object.keys(STYLE_SCHEMA.properties)) if (args && args[key] !== undefined) style[key] = args[key];
      if (Object.keys(style).length === 0) return text("Name at least one setting to change. Nothing was changed.", true);
      return await call({ kind: "style", style }, (result) => `Saved. This chat's settings are now: ${styleWords(result.style)}.`)();
    },
  };
  if (group === null) {
    const reviewSharing = {
      tool: {
        name: "review_sharing_set",
        description:
          "Turn on or off sharing this person's finished conversations with Tex with the Context team, so the team can improve Tex. " +
          "Only when they ask for it. share: true to share, false to stop.",
        inputSchema: { type: "object", properties: { share: { type: "boolean" } }, required: ["share"] },
      },
      call: async (args) => {
        if (typeof args?.share !== "boolean") return text("Say whether to share (true) or stop (false). Nothing was changed.", true);
        if (!(await asked("review_sharing"))) return text(OWN_WORDS_REFUSAL, true);
        return await call({ kind: "review_sharing", share: args.share }, (result) =>
          result.sharing ? "Saved: their finished conversations will be shared with the Context team." : "Saved: their conversations are no longer shared.",
        )();
      },
    };
    return [settingsGet, styleSet, reviewSharing];
  }
  const engagement = {
    tool: {
      name: "chat_engagement_set",
      description:
        "Change when Tex speaks up in this group: quiet (only when named), attentive (also an asker's follow-ups on an ask Tex is waiting on), " +
        "followAlong (also follow-ups to Tex's last answer), helpful (also when Tex can genuinely help). Anyone in the chat may change it.",
      inputSchema: { type: "object", properties: { style: { type: "string", enum: ["quiet", "attentive", "followAlong", "helpful"] } }, required: ["style"] },
    },
    call: async (args) => await call({ kind: "engagement", engagement: args?.style }, (result) => `Saved: Tex now speaks up here as ${result.engagement}.`)(),
  };
  const mute = {
    tool: {
      name: "chat_mute",
      description:
        "Stop Tex in this group chat until someone texts \"Tex, start\". Only when someone in the chat asks Tex to stop, be quiet or mute. Anyone here may.",
      inputSchema: { type: "object", properties: {} },
    },
    call: call({ kind: "mute" }, () => 'Done: Tex is muted here. Tell them anyone can text "Tex, start" to bring it back.'),
  };
  const status = {
    tool: {
      name: "chat_status",
      description: "Read which workspace this group chat uses and whether it is a guest chat. Takes no arguments.",
      inputSchema: { type: "object", properties: {} },
    },
    call: call({ kind: "status" }, (result) =>
      result.guest ? `This chat is a guest chat of @${result.slug}: Tex sees only what is shared with it.` : `This chat uses @${result.slug}.`,
    ),
  };
  if (group.guestTagger === true) return [settingsGet, styleSet, engagement, mute, status];
  const shareMail = {
    tool: {
      name: "chat_share_mail",
      description:
        "Share the asking person's own connected Gmail with this group chat, optionally narrowed by a Gmail search (query). Only the mailbox's own " +
        "person can, in a chat on a shared workspace they can edit; anything else is refused and changes nothing.",
      inputSchema: { type: "object", properties: { address: { type: "string" }, query: { type: "string" } }, required: ["address"] },
    },
    call: async (args) =>
      !(await asked("share_mail")) ? text(OWN_WORDS_REFUSAL, true) : await call({ kind: "share_mail", address: args?.address, ...(args?.query ? { query: args.query } : {}) }, (result) =>
        `Shared ${result.address} with this chat${result.narrowed ? ", narrowed by its search" : ""}. Replies go from it only when they say yes.`,
      )(),
  };
  const unshareMail = {
    tool: {
      name: "chat_unshare_mail",
      description: "Stop sharing the asking person's own mail with this chat: one address, or all of theirs when no address is given. Never anyone else's.",
      inputSchema: { type: "object", properties: { address: { type: "string" } } },
    },
    call: async (args) =>
      !(await asked("unshare_mail")) ? text(OWN_WORDS_REFUSAL, true) : await call({ kind: "unshare_mail", ...(args?.address ? { address: args.address } : {}) }, (result) =>
        result.count > 0 ? `Stopped sharing ${result.count === 1 ? "that mailbox" : `${result.count} mailboxes`} with this chat.` : "None of their mail was shared here, so nothing changed.",
      )(),
  };
  return [settingsGet, styleSet, engagement, mute, status, shareMail, unshareMail];
}

/** The `send` actions these tools are shown as (`sixTools.js`). */
export const COMMAND_SEND_ACTIONS = {
  tex_settings: { tool: "tex_settings_get", summary: "Read Tex's settings in this chat and the options to choose from." },
  tex_style: { tool: "tex_style_set", summary: "Change how Tex talks in this chat; the only way settings change." },
  chat_engagement: { tool: "chat_engagement_set", summary: "Change when Tex speaks up in this group." },
  chat_mute: { tool: "chat_mute", summary: "Mute Tex in this group, when someone asks it to stop." },
  chat_status: { tool: "chat_status", summary: "Which workspace this group chat uses." },
  chat_share_mail: { tool: "chat_share_mail", summary: "Share the asker's own Gmail with this group chat." },
  chat_unshare_mail: { tool: "chat_unshare_mail", summary: "Stop sharing the asker's own mail with this chat." },
  review_sharing: { tool: "review_sharing_set", summary: "Turn sharing their finished conversations with the Context team on or off." },
};
