/**
 * THE FRIEND CHECK: A GROUP DRAFT THAT USED A MEMBER CARD IS READ BEFORE IT GOES (decided by the owner, Sayo,
 * 2026-11-24; `docs/decisions/texting-assistant/member-cards.md`).
 *
 * The cards (`memberCards.js`) are hints to plan with and never to say. Code keeps them out of the chat's records; this
 * is the second line: one small model call reads the draft beside the cards and what was said in the chat, and answers
 * whether it quotes a hint, explains one, hints at the reason behind one, or says somebody told Tex something. Then the
 * draft goes back once with what to take out (`friendNotice`), never naming the private fact itself. It runs only on a
 * turn that had a card, once per draft, and a failure or a late answer lets the draft go: the cards' own wording is the
 * first line, and a check that can't answer never holds a reply.
 */

const OK = "OK";
const MAX_CHAT_LINES = 12;
const MAX_LINE = 300;

/** What the check is asked. */
export function friendQuestion({ draft, cards, chat }) {
  return [
    "This is not a text from a person. Nobody is waiting, and nothing you say is texted to anyone.",
    "A group chat's Tex drafted the reply below. It was given private hints about people in the chat, written by each person's " +
      "own Tex, to plan with and never to say. Does the draft quote a hint, explain one, hint at the reason behind one (a health " +
      "condition, money, drinking, a relationship, anything private), or say or suggest that someone told Tex something? " +
      "Planning around a hint without saying it is right: a dinner that suits everyone, a time that works. Anything someone said " +
      "in this chat (the lines below) is the chat's own and fine to repeat.",
    `Answer exactly ${OK}, or BACK: and one short line saying what to take out, without repeating the private fact.`,
    `## Private hints\n\n${cards.map((card) => `@${card.handle}: ${card.lines.join("; ")}`).join("\n")}`,
    chat.length > 0 ? `## Said in this chat\n\n${chat.join("\n")}` : "",
    `## The draft\n\n${String(draft ?? "").trim()}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The verdict from the model's answer: `{ to: "pass" }` or `{ to: "back", why }`; anything unclear passes. */
export function readFriendVerdict(answer) {
  const words = String(answer ?? "").trim();
  const back = /^BACK:\s*(.+)$/is.exec(words);
  if (back === null) return { to: "pass" };
  return { to: "back", why: back[1].replace(/\s+/g, " ").trim().slice(0, MAX_LINE) };
}

/** What the front door is told when its draft goes back. */
export function friendNotice(why) {
  return (
    `Before this goes to the chat: ${why} ` +
    "Rewrite it so it still works for everyone here, without saying, explaining or hinting at anything a person told you privately, " +
    "or that anyone told you anything."
  );
}

/** The chat's last lines, as plain `who: words`, from the turn's history. */
export function chatLinesOf(history) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => typeof turn?.text === "string" && turn.text.trim() !== "")
    .slice(-MAX_CHAT_LINES)
    .map((turn) => `${turn.role === "assistant" ? "Tex" : turn.who ?? turn.from ?? "Someone"}: ${turn.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE)}`);
}
