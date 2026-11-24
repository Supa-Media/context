/**
 * Tex's own sends in the test chat, drawn as Messages draws them on Tex's iMessage line (Dev, 2026-11-24, approved
 * artboards `group-chat-features-artboards/` 01, 02, 04 and 05). The simulated group keeps Tex's words as Tex wrote
 * them, marks and all, the way they reach the line: "(sent with Slam) …" (`packages/tex/worker/sendEffect.ts`),
 * "(poll) <question>" with its choices (`sendPoll.ts`), "@handle" tags (`groupTags.ts`), and the event line the
 * simulated group logs for running the group (`simulatedGroup.ts`). Each is read back here so a reviewer sees what the
 * chat would see, never the marks. A person's typed "@Tex" stays plain words, as iMessage sends it (Dev, 2026-11-24:
 * "do it like imessage").
 *
 * Pure: no React.
 */

/** The effects Messages names, by the name in Tex's mark, lower case, to the name shown under the bubble. */
const EFFECTS: Readonly<Record<string, string>> = {
  slam: "Slam",
  loud: "Loud",
  gentle: "Gentle",
  "invisible ink": "Invisible Ink",
  confetti: "Confetti",
  fireworks: "Fireworks",
  balloons: "Balloons",
  love: "Love",
  lasers: "Lasers",
  spotlight: "Spotlight",
  echo: "Echo",
  celebration: "Celebration",
  "shooting star": "Shooting Star",
};
const EFFECT = /^\s*\(sent with ([A-Za-z ]{2,20})\)[ \t]*/i;
const POLL = /^\s*\(poll\)[ \t]*/i;
const ITEM = /^\s*(?:[-•*]|\d{1,2}[.)])\s+(.+?)\s*$/;

export type TexSend = { text: string; effect?: string; poll?: { title: string; choices: string[] } };

/** One bubble's words without Tex's marks, and the effect or poll they asked for (as the line sends them). */
export function texSendOf(words: string): TexSend {
  let text = words;
  let effect: string | undefined;
  const e = EFFECT.exec(text);
  if (e) {
    const name = EFFECTS[e[1]!.trim().toLowerCase()];
    const rest = text.slice(e[0].length);
    if (name && rest.trim() !== "") ((effect = name), (text = rest));
  }
  const p = POLL.exec(text);
  if (p) {
    const lines = text.slice(p[0].length).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
    const title = (lines.shift() ?? "").trim();
    const choices = lines.map((l) => ITEM.exec(l)?.[1]?.trim() ?? null);
    if (title && choices.length >= 2 && choices.length <= 12 && choices.every((c) => c !== null)) return { text: title, poll: { title, choices: [...new Set(choices as string[])] }, ...(effect ? { effect } : {}) };
    text = text.slice(p[0].length);
  }
  return { text, ...(effect ? { effect } : {}) };
}

/** The event line a row of Tex's is, when the simulated group logged running the group; else null. */
export function texEventOf(text: string): { text: string; photo: boolean } | null {
  const t = text.trim();
  if (/^Tex named the conversation “.{1,100}”\.$/u.test(t) || /^Tex added \S.{0,80} to the conversation\.$/u.test(t)) return { text: t, photo: false };
  if (t === "Tex changed the group photo.") return { text: t, photo: true };
  return null;
}

export type TagSeg = { t: string; tag?: true };

/**
 * Tex's words with each "@handle" of someone in the chat as their name, a tag (bold, no @, as Messages draws one).
 * `handles` is each person's name to their handle; an @word that is nobody's stays as written.
 */
export function texTags(text: string, handles: Record<string, string | undefined>): TagSeg[] {
  const byHandle = new Map<string, string>();
  for (const [name, handle] of Object.entries(handles)) if (handle) byHandle.set(handle.replace(/^@/, "").toLowerCase(), name.split(/\s+/)[0]!);
  const out: TagSeg[] = [];
  let at = 0;
  for (const m of text.matchAll(/(?<![\w@.])@([a-z0-9][a-z0-9-]{0,63})(?![\w-])/gi)) {
    const name = byHandle.get(m[1]!.toLowerCase());
    if (!name) continue;
    if (m.index! > at) out.push({ t: text.slice(at, m.index) });
    out.push({ t: name, tag: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length || out.length === 0) out.push({ t: text.slice(at) });
  return out;
}
