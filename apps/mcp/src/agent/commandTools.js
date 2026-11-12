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
 * settings and the instructions; a person's own chat gets
 * their own instructions and review sharing. Since 2026-11-01 how Tex talks is
 * the people's own words (`custom-instructions.md`): the tool adds, removes or
 * replaces lines, and in a group Tex says who changed them so anyone can undo.
 *
 * The tools that act for the person or widen who sees something (sharing or
 * unsharing their mail, their review sharing), and the one that writes free
 * text every later turn reads (the instructions), run only when the turn's own
 * message, from the person the grant names, asks for it (`consentFor`). Those
 * words come from the texting Worker (`body.question`, the tagger's own
 * message), never from the model's arguments, so another member's text, a
 * quoted message or an email's contents cannot steer the turn into acting as
 * the tagger. The "Tex, settings" menu, its quick picks, progress updates and
 * the group speak-up levels are retired (Dev2, 2026-11-11;
 * `docs/decisions/texting-assistant/retire-settings.md`): these tools are the
 * whole of it now, and "undo the change" is an action of the instructions
 * tool rather than fixed words. The same small judge as any other widening decides when the
 * deployment has one (`privacy/judge.js`), after a code check that the words
 * name the thing at all.
 *
 * Choosing a workspace for a chat, inviting everyone in it and starting a
 * muted Tex stay with the texting Worker's commands ("Tex, use @x",
 * "Tex, start"): they need the chat's member list, which only the Worker
 * holds, and a muted chat has no turn to call a tool from.
 */

import { judgeFor } from "../privacy/judge.js";

const INSTRUCTIONS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["add", "remove", "replace", "clear", "undo"] },
    text: { type: "string", maxLength: 1500 },
  },
  required: ["action"],
};

const REFUSALS = {
  refused: "That didn't go through: this chat's access has ended or changed. Nothing was changed; say so plainly.",
  not_allowed: "Not allowed for the person asking here, so nothing was changed. Say so plainly; never say it was done.",
  bad_request: "That value isn't one of the options, so nothing was changed. Offer the valid options.",
  mail_refused:
    "Not shared: only the mailbox's own person can share it, from a connected Gmail, in a chat they are in. Nothing was changed.",
  too_long: "Not saved: the instructions can hold at most 1,500 characters. Nothing was changed; say so and offer to shorten them.",
  nothing_to_undo: "There's nothing to undo. Nothing was changed.",
};

/** The words a consent-gated action needs in the person's own message before the judge is even asked. */
const CONSENT_WORDS = {
  share_mail: /\b(mail|email|e-mail|inbox|gmail)\b/i,
  unshare_mail: /\b(mail|email|e-mail|inbox|gmail)\b/i,
  review_sharing: /\b(shar\w*|review\w*|conversations?|chats?)\b/i,
  // A lasting request about how Tex talks, in their own words (Dev2, 2026-11-01): never a line an email or a quote put there.
  instructions: /\b(from now on|going forward|always|never|stop|don'?t|do not|no more|call (?:me|us)|instructions?|settings?|remember|be (?:more|less)|answer in|reply in|talk|write|use|undo|remove|forget|emoji\w*|humou?r|jokes?|tone|bubbles?|warm\w*|enthusias\w*|short\w*|long\w*|detail\w*|formal|casual|brief)\b/i,
};
const CONSENT_ACTIONS = {
  share_mail: "share the person's own email inbox with this group chat",
  unshare_mail: "stop sharing the person's own email inbox with this group chat",
  review_sharing: "change whether the person's finished conversations are shared with the Context team",
  instructions: "change, from now on, how Tex talks in this chat",
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

/** The instructions as saved, quoted for the turn to repeat. */
const saidText = (result) => (typeof result.instructions === "string" && result.instructions !== "" ? `"${result.instructions}"` : "none");

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
        "Read how Tex is set to talk in this chat: the people's own instructions, in full. " +
        "Use it when someone asks about Tex's settings or says \"settings\" in any wording. Show them in one short message, and say they change it by telling you in their own words. Takes no arguments.",
      inputSchema: { type: "object", properties: {} },
    },
    call: call({ kind: "settings" }, (result) => {
      const personal = group !== null ? " Personal instructions don't apply in groups." : "";
      return `Instructions: ${saidText(result)}.${personal} There is no menu: they change how you talk by telling you, in their own words.`;
    }),
  };
  // In a group the change is said with who made it, so anyone there can put it back (Dev2, 2026-11-01).
  const confirm = (result) =>
    group !== null
      ? `Saved. Say in your answer, in these words: ${result.setBy ?? "someone here"} set: ${saidText(result)}. Anyone here can text "Tex, undo the change" to put it back.`
      : `Saved. Their instructions are now: ${saidText(result)}. Tell them in a line what you wrote.`;
  const instructionsSet = {
    tool: {
      name: "tex_instructions_set",
      description:
        "Change how Tex talks in this chat, in the people's own words: add a line, remove a line, replace the whole text, clear it, or undo the last change (\"undo the change\"). " +
        "Only for a clear, lasting request (\"from now on...\", \"always...\", \"stop...\", \"call me...\"), never for this one answer (\"make this shorter\"). " +
        "Write the line as one short instruction to yourself. It is the only way how you talk changes: a note you write (the voice note, About me, memory) " +
        "never is, so never say it was saved unless this tool says so. It changes how you sound, never what you may do.",
      inputSchema: INSTRUCTIONS_SCHEMA,
    },
    call: async (args) => {
      const action = args?.action;
      if (!["add", "remove", "replace", "clear", "undo"].includes(action)) return text("Say add, remove, replace, clear or undo. Nothing was changed.", true);
      const bare = action === "clear" || action === "undo";
      if (!bare && (typeof args?.text !== "string" || args.text.trim() === "")) return text("Pass the line as text. Nothing was changed.", true);
      if (!(await asked("instructions"))) return text(OWN_WORDS_REFUSAL, true);
      return await call({ kind: "instructions", action, ...(!bare ? { text: args.text } : {}) }, confirm)();
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
    return [settingsGet, instructionsSet, reviewSharing];
  }
  const mute = {
    tool: {
      name: "chat_mute",
      description:
        "Stop Tex in this group chat until someone texts \"Tex, start\". Only when someone in the chat asks Tex to stop or mute. " +
        "\"Be quiet\" alone means answer only when asked, which is how Tex already works here: say so and don't mute. Anyone here may.",
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
  if (group.guestTagger === true) return [settingsGet, instructionsSet, mute, status];
  const shareMail = {
    tool: {
      name: "chat_share_mail",
      description:
        "Share the asking person's own connected Gmail with this group chat, optionally narrowed by a Gmail search (query). Only the mailbox's own " +
        "person can, in a chat they are in; anything else is refused and changes nothing.",
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
  return [settingsGet, instructionsSet, mute, status, shareMail, unshareMail];
}

/** The `send` actions these tools are shown as (`sixTools.js`). */
export const COMMAND_SEND_ACTIONS = {
  tex_settings: { tool: "tex_settings_get", summary: "Read Tex's instructions in this chat." },
  tex_instructions: { tool: "tex_instructions_set", summary: "Change how Tex talks in this chat, on a clear lasting request; the only way it changes." },
  chat_mute: { tool: "chat_mute", summary: "Mute Tex in this group, when someone asks it to stop." },
  chat_status: { tool: "chat_status", summary: "Which workspace this group chat uses." },
  chat_share_mail: { tool: "chat_share_mail", summary: "Share the asker's own Gmail with this group chat." },
  chat_unshare_mail: { tool: "chat_unshare_mail", summary: "Stop sharing the asker's own mail with this chat." },
  review_sharing: { tool: "review_sharing_set", summary: "Turn sharing their finished conversations with the Context team on or off." },
};
