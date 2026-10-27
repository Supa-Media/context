/**
 * What Tex says in a group with no model, and how the chat's lines read
 * (moved out of `groupInbox.ts` whole, so the queue stays under its size limit).
 */

import type { GuestInfo } from "./groupControl";

/** How a picture sent without words reads in the chat Tex is handed. */
export const PICTURE_LINE = "(sent a picture or file)";
/** The fixed lines, sent with no model. */
export const GROUP_LINES = {
  intro: (slug: string) =>
    `Hi, I'm Tex. Start a message with "Tex" and I'll answer here, using only @${slug}, the workspace everyone in this chat shares. ` +
    `I follow the chat so you can just say "Tex, write this up", and keep it in @${slug}. "Tex, stop" mutes me and "Tex, start" brings me back.`,
  unknown: "I answer people who've set me up. Text me on your own to start.",
  noShared:
    "I can only use notes everyone in this chat can open, and not everyone here shares a workspace with me. Text me on your own instead.",
  choose: (slugs: string[]) =>
    `You all share ${slugs.map((slug) => `@${slug}`).join(" and ")}. Which one should I use here? Just say its name.`,
  notShared: (slugs: string[]) =>
    "That isn't a workspace everyone in this chat shares." +
    (slugs.length > 0 ? ` You all share ${slugs.map((slug) => `@${slug}`).join(", ")}. Say "Tex use @${slugs[0]}" to pick one.` : ""),
  bound: (slug: string, intro = false) =>
    `Got it, I'll use @${slug} in this chat.` +
    (intro
      ? ` Start a message with "Tex" when you need me. I follow the chat so you can just say "Tex, write this up", and keep it in @${slug}. ` +
        `"Tex, stop" mutes me and "Tex, start" brings me back.`
      : ""),
  status: (slug: string) => `In this chat I can see @${slug}, and only what everyone there can open.`,
  // Guest mode (`docs/decisions/texting-assistant/group-guests.md`): people here who aren't on Context are guests.
  guestBound: (slug: string, guest: GuestInfo) =>
    `Got it. Everyone here is a guest of @${slug} now, as the group @${guest.group}. I only see notes shared with that group, ` +
    `and I keep what I make for this chat in ${guest.folder}. Anyone here can start a message with "Tex" to ask me something. "Tex, stop" mutes me.`,
  guestIntro: (slug: string, guest: GuestInfo) =>
    `Hi, I'm Tex. Anyone here can start a message with "Tex" and I'll answer, using only notes shared with @${guest.group} in @${slug}. ` +
    `I keep what I make in ${guest.folder}. "Tex, stop" mutes me and "Tex, start" brings me back.`,
  guestStatus: (slug: string, guest: GuestInfo) => `In this chat I can see only notes shared with @${guest.group} in @${slug}.`,
  notAllowed: (slug: string) => `Only an owner or editor of @${slug} can bring it into this chat. One of them can say "Tex use @${slug}".`,
  // Invited family (`docs/decisions/texting-assistant/invited-family.md`): an owner adds everyone here by number.
  invited: (slug: string, count: number, role: string) =>
    count === 0
      ? `Everyone here is already in @${slug}, so I'll use it in this chat.`
      : `Done. I invited ${count === 1 ? "1 person" : `${count} people`} here to @${slug} as ${role === "member" ? "members who can read" : "editors"}. ` +
        `Their invitation counts in this chat, so I can use all of @${slug} here now. ` +
        "Each of them joins for good the first time they text me or sign in to Context with the number they use here.",
  notOwner: (slug: string) => `Only an owner of @${slug} can add people to it. They can say "Tex add everyone here to @${slug}".`,
  guestsOff:
    "The person who brought me into this chat can't share that workspace here anymore, so I'm stepping back. " +
    'An owner or editor can say "Tex use @name" to start again.',
  stopped: `Okay, I'll stay quiet here. Say "Tex, start" when you want me back.`,
  started: "I'm back. Start a message with \"Tex\" when you need me.",
  joined: "Someone joined while I was working on that, so I didn't send it. Ask me again.",
  sms: "I only answer in iMessage group chats.",
  failed: "I couldn't answer that one. Try again in a bit.",
} as const;

