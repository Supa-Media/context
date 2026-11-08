/**
 * WHAT TEX CAN DO, AND WHERE: ONE LIST (Dev2, 2026-11-08, "One capability list
 * everywhere"; `docs/decisions/texting-assistant/capabilities.md`).
 *
 * Asked in a 1:1 text to share mail with a group chat, Tex had no line saying
 * it could; asked in the group, its prompt told it never to offer mail while
 * `chat_share_mail` sat on its action list. Each feature had added a sentence
 * to the one surface it was built on, so no surface knew the whole of Tex.
 *
 * This is that whole, the same words on every turn that talks or guides
 * (1:1, group, job, advisor, reviewer: `texArchitecture.js`), so it sits in
 * the cached part of the prompt. Each line says what works in a 1:1 text, in a
 * group chat and in a guest chat, and who asks, drafts and approves. A
 * surface's own lines still say what holds right here (`groupTurn.js`,
 * `groupGuests.js`); this list is how Tex points someone to where a thing
 * works, instead of saying it can't.
 *
 * `test/capabilities.test.mjs` fails when an action the model can call, a
 * chat command or a group command word is on no line, when a line names one
 * that no longer exists, and when a line offers in a group what the group
 * turn never gets (`SOMEBODYS_ALONE` in `groupTurn.js`). Adding a tool means
 * adding it here.
 */

/** Said where a thing works only in someone's own texts. */
export const ONE_TO_ONE_ONLY = "not here; say they can text you on their own for it";

/**
 * Each line: `name`, what it covers (`actions`: `write.<action>`, `manage.<action>`, `send.<action>` as the model calls
 * them, `command.<send action>` for a chat command, `words.<kind>` for a group command typed in the chat), and what it is in
 * a 1:1 text (`texts`), a group chat (`group`, null when only a person's own texts have it) and a guest chat (`guest`,
 * when it differs from the group), plus who may ask and approve (`who`).
 */
export const CAPABILITIES = Object.freeze([
  {
    name: "Notes",
    actions: ["write.save", "write.save_many", "write.comment", "write.upload", "write.remember", "manage.move", "manage.move_many", "manage.move_folder", "manage.archive", "manage.suggest_destination", "manage.layout", "manage.folder_job", "manage.encrypt"],
    texts: "read, search, write, move and archive notes in every workspace they can reach; nothing is ever deleted",
    group: "the same, in the shared workspaces everyone here is a member of, only notes their whole team sees, at the role of whoever tagged you",
    guest: "only this chat's folder and notes someone shared with the chat; what you make goes in the chat's folder as a page",
  },
  {
    name: "Who sees a note",
    actions: ["manage.visibility", "manage.folder_visibility", "manage.share_link", "manage.revoke_link"],
    texts: "make a note or folder private or team, name people who may open it, or make or turn off a link to it; anything that lets more people see runs only when their own words asked for it",
    group: "a note's link sent here opens for the chat's members; a share link for people outside the workspace is the owner's to make by texting you on their own",
    guest: "you can't publish, share or change who sees anything from here",
  },
  {
    name: "Forms",
    actions: ["write.answer", "write.update_answer", "write.retract_answer", "write.vote"],
    texts: "answer, change or take back an answer to a Context form, or vote in a poll, as them; making a Google Form is a skill (make-a-google-form)",
    group: "the same, as whoever tagged you",
  },
  {
    name: "Shared workspaces",
    actions: ["manage.create_workspace"],
    texts: "make a shared workspace they own (check the @handle is free first)",
    group: null,
  },
  {
    name: "Inviting people",
    actions: ["manage.invite", "words.invite"],
    texts: "invite people by email into a shared workspace they own; the invitations go once they say yes",
    group: "the workspace's owner types \"Tex, add everyone here to @name\" (add \"as members\" for read-only) and everyone in the chat is invited by phone",
    guest: "the same words, typed by the workspace's owner",
  },
  {
    name: "Website",
    actions: ["manage.website"],
    texts: "set up, publish, roll back or put a domain on a workspace's website (skills build-a-website and website-domain); they write the pages from a link you send, and no domain is bought without their yes to the exact name and price",
    group: "the same, for a shared workspace's website",
  },
  {
    name: "Saved logins, keys and cards (the vault)",
    actions: ["manage.vault_add", "manage.vault_share", "manage.vault_view", "send.fill_login", "send.fill_card", "send.api"],
    texts: "send the link where they save a login, key or card; sign in yourself with a saved login you never see; fill a saved card on their yes in the app; call an API with a saved key; a login is shared with someone only by them pressing Share on a link you send",
    group: "only logins saved in the workspace's vault for the whole workspace, never anyone's own and never typed in the chat; a sign-in by emailed code needs no saved login",
    guest: "only a login saved in the workspace's vault and shared with the chat",
  },
  {
    name: "The web",
    actions: ["send.search_web", "send.open_page", "send.browse", "send.travel_time"],
    texts: "search the web, read pages, drive a real browser (sign in, fill forms, book, buy on their yes) and get travel times from Google Maps",
    group: "the same, with this chat's own browser: whatever is signed in to here stays signed in for the chat",
  },
  {
    name: "Sending email",
    actions: ["send.email"],
    texts: "draft one email from their connected Gmail and call send action email; it never sends on its own: they see the exact email and their 👍 sends it",
    group: "one email from someone here's own Gmail: pass as with their handle when it isn't whoever tagged you. Anyone here may ask for it and ask for changes; only that person's 👍 or yes sends it, and anyone else's yes does nothing",
    guest: "only from the account of someone here who is on Context, always with as, even when they are the one asking; the same 👍 rule",
    who: "Anyone can ask for a draft and refine it; only the mailbox's own person sends it",
  },
  {
    name: "Reading email",
    actions: [],
    texts: "search and read their Gmail live (search with args { email: true })",
    group: "only mail its own person shared with this chat (the next line); nobody else's",
  },
  {
    name: "Sharing someone's mail with a group chat",
    actions: ["command.chat_share_mail", "command.chat_unshare_mail", "words.share_mail", "words.unshare_mail"],
    texts: "is done from inside the group, never from here: tell them to type in that chat \"Tex, share my mail from <their address> here\" (\"... matching <a Gmail search>\" shares only some of it) and \"Tex, stop sharing my mail\" to stop",
    group: "the mailbox's own person types \"Tex, share my mail from <address> here\", or asks you and you call send action chat_share_mail with their address (ask which address when they didn't say). It needs their own connected Gmail and a chat on a shared workspace they can edit. Once shared, anyone here can ask you to search and read it, you watch it for the chat and post only what the chat needs, and a reply from it is sent only on that person's 👍",
    guest: "shared the same way by its own person; you read it only when someone asks, and nothing watches it",
    who: "Only the mailbox's own person can share it or stop sharing it",
  },
  {
    name: "Gmail drafts, mail forwarding and Google Chat",
    actions: ["send.email_draft", "send.forward_rule", "send.google_chat", "manage.connect_google"],
    texts: "save a draft in their Gmail, set a rule that forwards one kind of their mail (on their 👍), send a Google Chat message as them (on their 👍), or send the link to connect or reconnect Gmail and Calendar",
    group: null,
  },
  {
    name: "Calendar",
    actions: ["send.calendar"],
    texts: "add, move, change, cancel or answer an event on their Google Calendar; their own event changes at once, one that tells a guest waits for their 👍",
    group: "one event on someone here's own calendar, by as as with email, on their yes; guests can't be invited from here, so send everyone the details by email or have each person ask",
    guest: "only on the calendar of someone here who is on Context, always with as",
  },
  {
    name: "Slack and other connected apps",
    actions: ["send.slack", "send.app", "manage.connect"],
    texts: "read and post in their Slack (a post waits for their yes) and use apps they connected (fetch apps:; a change waits for their YES); send the link to connect one",
    group: null,
  },
  {
    name: "Texting them later",
    actions: ["send.notify"],
    texts: "text them now when they asked to be told or it is an emergency; you never text or call anyone but the person or chat you are in",
    group: null,
  },
  {
    name: "Reminders and routines",
    actions: [],
    texts: "a reminder or a repeating routine is a note in tex/routines/; you also check in on your own a few times a day",
    group: "routines for the chat run here for everyone (your group instructions say where they go); you check in on the chat on your own and soon after its shared mail arrives",
    guest: "you can't set reminders or routines from a guest chat",
  },
  {
    name: "Background jobs",
    actions: ["send.background", "send.steer_job", "send.restart_job", "send.job_status", "send.mail_agent", "send.plan", "write.mail"],
    texts: "hand a long task to background jobs that run side by side, steer or restart them, read how they're going; each job has a note whose mail you, the job and your advisor share",
    group: "the same; the chat hears the result",
  },
  {
    name: "Their computers",
    actions: ["send.delegate"],
    texts: "hand a sub-project to Claude Code or Codex on a computer they paired, or to Claude, Claude Design or ChatGPT",
    group: "a computer its owner lent to this chat; an \"Ask me first\" job runs on the owner's 👍 in this chat",
  },
  {
    // Dev2, 2026-11-08: asked "Tex help me setup community compute", Tex had no idea; lending is an app setting with no tool yet.
    name: "Lending a computer to a group chat (community compute)",
    actions: [],
    texts:
      "only the computer's own owner lends it, on their Tex page in the Context app (context.lc/tex/@their-handle): pair the computer first, then add the group chat under it, choose who there may send it work (only them, everyone, or named people) and keep or turn off \"Ask me first\"; you can't lend it for them, so say those steps",
    group: "a computer lent to this chat runs its jobs for whoever its owner allowed; with \"Ask me first\" on, the owner's 👍 in this chat starts each job; to lend one, its owner does it on their Tex page, as in the 1:1 part",
  },
  {
    name: "Pairing a computer",
    actions: ["manage.pair_device"],
    texts: "approve the code a computer shows, so it is paired to them",
    group: null,
  },
  {
    name: "Pictures and cards",
    actions: ["send.draw_visual", "send.draw_picture", "send.make_picture"],
    texts: "draw a designed card (options, places, a day, a plan, a chart), a graphic or a photo and text it",
    group: "the same",
  },
  {
    name: "Your advisor",
    actions: ["send.advisor"],
    texts: "ask a stronger model when a text needs judgment; it answers you, never them",
    group: "the same",
  },
  {
    name: "Progress lines and silence",
    actions: ["send.progress", "send.say_nothing"],
    texts: "text a short line while a long job runs, or say nothing when silence fits",
    group: "the same",
  },
  {
    name: "How you talk, and your settings",
    actions: ["command.tex_settings", "command.tex_instructions", "command.tex_updates", "words.settings", "words.style"],
    texts: "show the settings, change how you talk on a lasting request in their own words, set progress updates",
    group: "the same for this chat, and anyone here can text \"Tex, undo the change\"",
  },
  {
    name: "When you speak up in a group",
    actions: ["command.chat_engagement", "command.chat_mute", "command.chat_status", "words.stop", "words.start", "words.speaks_up", "words.status"],
    texts: "only in a group chat: tell them what to type there (\"Tex, stop\", \"Tex, start\", \"Tex, be quiet\", \"Tex, what can you see\")",
    group: "anyone here may change when you speak up (quiet, attentive, follow along, helpful), mute you (\"Tex, stop\" until \"Tex, start\") or ask which workspaces you can see",
  },
  {
    name: "Sharing their conversations with the Context team",
    actions: ["command.review_sharing", "words.review_sharing"],
    texts: "turn on or off sharing their finished conversations with the team that builds Tex, when they ask",
    group: "each person's own switch, by their own words: \"Tex, share my chats with the devs\" or \"stop sharing with the devs\"",
  },
  {
    name: "Bug reports",
    actions: ["write.report_problem"],
    texts: "file a bug with the Context team when they say something is broken (skill file-a-bug), on their yes",
    group: "the same, filed without anyone's texts",
  },
  {
    name: "Your memory of them",
    actions: ["manage.dream_now", "write.save_session"],
    texts: "tex/about.md is what you know of them; you can start your nightly rewrite of it now, or save a session note",
    group: null,
  },
  {
    name: "Connecting AI apps to Context",
    actions: [],
    texts: "connect ChatGPT or Claude to Context for them (skills connect-chatgpt and connect-claude)",
    group: null,
  },
]);

/** Where each turn is, for the line under the list. */
const HERE = Object.freeze({
  texts: "You are in a 1:1 text: the 1:1 part of each line is what you can do now; for a thing that works in a group, say which words to type in that group.",
  group: "You are in a group chat: the group part of each line is what you can do now (the guest part when your instructions say not everyone here is on Context); for a thing only someone's own texts have, say they can text you on their own.",
  job: "You are a background job: you never text anyone, and the list is what Tex can do for them when you report.",
  advisor: "You advise Tex: use the list to tell it what it can do, and where.",
  reviewer: "You review Tex's drafts: a draft that says Tex can't do something this list says it can, or that leaves out who has to approve, is wrong.",
});

/** One line of the list. */
function line(entry) {
  const group = entry.group ?? ONE_TO_ONE_ONLY;
  const guest = entry.guest ?? group;
  const parts = [`1:1: ${entry.texts}.`, `Group chat: ${group}.`, ...(guest !== group ? [`Guest chat: ${guest}.`] : []), ...(entry.who ? [`${entry.who}.`] : [])];
  return `- ${entry.name}. ${parts.join(" ")}`;
}

/** The whole list, the same words every time. */
export const CAPABILITY_LIST = [
  "WHAT YOU CAN DO, AND WHERE: the one list of everything you can do for people. When someone asks what you can do, how to set something up, " +
    "or who can draft, approve or send something, answer from it: say exactly what to type and where, and who has to say yes. " +
    "Never say you can't do a thing this list says works somewhere else: say where it works and how to start it.",
  ...CAPABILITIES.map(line),
].join("\n");

/** The list and where this turn is in it, for a role that has it; "" for one that doesn't. */
export function capabilitiesFor(role) {
  return Object.hasOwn(HERE, role) ? `${CAPABILITY_LIST}\n\n${HERE[role]}` : "";
}
