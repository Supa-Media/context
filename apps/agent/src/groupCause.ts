/**
 * Why a group turn runs, named for the gateway so Tex is never told "@jo tagged you" when nobody did (Dev2,
 * 2026-11-17). The chat's own check-in ran every four hours in Battle of the Bots and was told the sponsor had tagged
 * it; Tex looked for the tag, found none and texted "Yeah, what do you need?" into the chat. A follow-up the judge
 * picked up was told the same, and Tex then explained itself with "you'd just tagged me".
 *
 * - `check_in`: the chat's own check-in (`groupRoutines.ts` `CHAT_LOOK_PATH`); `routine`: one of its routines.
 * - `job_report`: work Tex started reported back; `cross_chat`: another of the person's Tex chats asked this one.
 * - `reaction`: a tapback on one of Tex's texts.
 * - `tagged`: a text here says "@Tex"; `named`: a text here says "Tex" by name.
 * - `judged`: none of those: the judge read a text as meant for Tex (a reply to it, or a follow-up on its answer).
 */
import type { GroupMessage } from "./sendblueGroups";
import { CHAT_LOOK_PATH } from "./groupRoutines";
import { tagsTex } from "./groupWords";

export type TurnCause = "check_in" | "routine" | "job_report" | "cross_chat" | "reaction" | "tagged" | "named" | "judged";

/** "Tex" as a word, the way people name it in a chat ("Tex, ...", "hey tex"), never inside another word. */
const NAMED = /(?<![\w-])tex(?![\w-])/i;

export function turnCause(message: Pick<GroupMessage, "routine" | "jobReport" | "crossChat" | "reaction" | "answersTapback">, covered: { text?: string; heard?: string }[]): TurnCause {
  if (message.routine !== undefined) return message.routine.path === CHAT_LOOK_PATH ? "check_in" : "routine";
  if (message.jobReport !== undefined) return "job_report";
  if (message.crossChat !== undefined) return "cross_chat";
  if (message.reaction !== undefined || message.answersTapback !== undefined) return "reaction";
  const said = covered.map((entry) => entry.text || entry.heard || "");
  if (said.some(tagsTex)) return "tagged";
  if (said.some((text) => NAMED.test(text))) return "named";
  return "judged";
}
