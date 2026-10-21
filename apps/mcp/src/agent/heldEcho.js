/**
 * An email held for the person's YES is texted to them whole, in the
 * gateway's own words (`textedApprovals.js`), so the model's answer must not
 * carry a copy of its own.
 *
 * On 2026-10-19 it did: Tex texted "The email didn't go through on my end, so
 * here it is to send yourself", its own To:, Subject: and body, and then the
 * held copy under "Here's the email I'd send", two different versions of one
 * email in one reply. The hold no longer reads to the model as a failure
 * (`turn.js`), and this drops what is left over: any paragraph of the answer
 * that is an email header block, or mostly the held email's own words, and a
 * line introducing one ("here it is:"). Whatever else the model said stays.
 */

import { EMAIL_TOOL } from "../tools/email.js";

/** A line that heads an email: "To: …", "Subject: …". */
const HEADER = /^\s*(?:from|to|cc|bcc|subject)\s*:/im;
/** The share of a paragraph's three-word runs found in the held email that make it a copy. */
const ECHO_SHARE = 0.5;
/** Fewer words than this is a line about the email ("Asked her for the deposit link."), never a copy of it. */
const MIN_WORDS = 24;

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}@.'’]+/gu)?.map((word) => word.replace(/[.’]+$/u, "").replace(/’/g, "'")) ?? [];

function runs(list) {
  const out = [];
  for (let i = 0; i + 3 <= list.length; i += 1) out.push(list.slice(i, i + 3).join(" "));
  return out;
}

function isCopy(paragraph, held) {
  if (HEADER.test(paragraph)) return true;
  const own = runs(words(paragraph));
  if (own.length < MIN_WORDS - 2) return false;
  return own.filter((run) => held.has(run)).length / own.length >= ECHO_SHARE;
}

/**
 * `answer` without the paragraphs that repeat an email this turn held. The
 * answer as it was when nothing held is an email.
 *
 * @param {string} answer the model's answer
 * @param {{ tool: string, detail?: unknown }[]} asked what the turn held for a yes
 */
export function withoutHeldEcho(answer, asked) {
  const copies = asked.filter((record) => record.tool === EMAIL_TOOL && typeof record.detail === "string");
  if (copies.length === 0 || typeof answer !== "string" || answer === "") return answer;
  const held = new Set(copies.flatMap((record) => runs(words(record.detail))));
  const paragraphs = answer.split(/\n\s*\n/);
  const copy = paragraphs.map((paragraph) => isCopy(paragraph, held));
  const kept = paragraphs.filter((paragraph, i) => {
    if (copy[i]) return false;
    // "So here it is to send yourself:" introduces a copy that is gone.
    return !(copy[i + 1] && paragraph.trim().endsWith(":"));
  });
  return kept.join("\n\n").trim();
}

/*
  Talk of a yes being waited on somewhere else. On 2026-10-21 Tex answered a
  held calendar change with "Still waiting on the calendar yes. Check your
  messages from Context for the confirmation and tap it", and the ask itself
  came right after it: there is no other message, app or confirmation, only
  the ask under these words. A sentence saying otherwise comes out.
*/
const WAIT_TALK =
  /\b(?:still waiting|waiting (?:on|for) (?:the|your)\b|check your (?:messages|texts|inbox|email|notifications|app)|messages? from context|(?:tap|approve|confirm) (?:it )?in (?:the )?(?:context )?app|the confirmation)/i;

/** `answer` without the sentences that send them looking for an ask other than the one below it. */
export function withoutWaitTalk(answer) {
  if (typeof answer !== "string" || !WAIT_TALK.test(answer)) return answer;
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !WAIT_TALK.test(sentence))
        .join(" "),
    )
    .filter((paragraph) => paragraph.trim() !== "")
    .join("\n\n")
    .trim();
}
