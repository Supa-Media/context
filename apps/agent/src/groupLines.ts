/**
 * What Tex says in a group with no model, and how the chat's lines read
 * (moved out of `groupInbox.ts` whole, so the queue stays under its size limit).
 */


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
  notAllowed: (slug: string) => `Only an owner or editor of @${slug} can bring it into this chat. One of them can say "Tex use @${slug}".`,
  // Invited family (`docs/decisions/texting-assistant/invited-family.md`): an owner adds everyone here by number.
  invited: (slug: string, count: number, role: string) =>
    count === 0
      ? `Everyone here is already in @${slug}, so I'll use it in this chat.`
      : `Done. I invited ${count === 1 ? "1 person" : `${count} people`} here to @${slug} as ${role === "member" ? "members who can read" : "editors"}. ` +
        `Their invitation counts in this chat, so I can use all of @${slug} here now. ` +
        "Each of them joins for good the first time they text me or sign in to Context with the number they use here.",
  // A mailbox shared with the chat (`docs/decisions/texting-assistant/chat-mail.md`): only by its own person.
  mailShared: (address: string, narrowed: boolean) =>
    `Done. Anyone here can ask me about ${narrowed ? "the mail you described in " : ""}${address}, and I'll keep an eye on it for this chat. ` +
    `Replies go from it only when you say yes. "Tex, stop sharing my mail" ends it.`,
  mailUnshared: (count: number) => (count === 0 ? "You weren't sharing any mail here." : "Done. I can't read that mail here anymore."),
  mailRefused:
    "I can only share a Gmail you've connected to Context yourself, in a chat that uses a workspace you can edit. " +
    "Text me on your own to connect it, then ask here again.",
  notOwner: (slug: string) => `Only an owner of @${slug} can add people to it. They can say "Tex add everyone here to @${slug}".`,
  stopped: `Okay, I'll stay quiet here. Say "Tex, start" when you want me back.`,
  started: "I'm back. Start a message with \"Tex\" when you need me.",
  joined: "Someone joined while I was working on that, so I didn't send it. Ask me again.",
  sms: "I only answer in iMessage group chats.",
  // Given up after the workflow's retries (`groupTurnRun.ts`): it says it tried, and that it's Tex's fault, not the asker's.
  failed: "Something broke on my side and I couldn't answer that. Ask me again in a few minutes.",
  // The chat's workspace couldn't be opened (the gateway's `storage_unavailable`; Tex Devs on 2026-10-29, when every
  // reply read "Try again in a bit" while the 1:1 answered): that, said plainly, since no rewording of the ask will help.
  noStorage: "I can't open this chat's workspace right now, so I can't answer here. It's a problem on my side, and it's been flagged.",
  // A turn whose workflow never started (`groupTurnRun.ts` `stuck`).
  stuck: "I'm having trouble answering right now. Try me again in a minute.",
} as const;

/** The line for a turn given up on, by the reason it was logged with (`turnFailed`). */
export function failedLine(reason: string | undefined): string {
  return reason === "gateway:503" ? GROUP_LINES.noStorage : GROUP_LINES.failed;
}
