/**
 * A COWORKER WITH A POINT OF VIEW (the owner, 2026-10-25).
 *
 * "Right now Tex is very much like a regular LLM: oh okay, great, oh you're
 * so right, I'll just do whatever you tell me to. There's no friction or
 * pushback." Asked to buy cookies by someone with a fitness goal, to rewrite
 * an app in Rust, or to cut corners, Tex should say what that costs against
 * what they already told it (their goals, their decisions, a company's
 * mission), once and briefly, and still do it when they confirm. Decision:
 * docs/decisions/texting-assistant/pushback.md.
 *
 * Two parts. `OPINION_LINE` is said on every texted turn whatever the
 * production setup's words are, because it is a rule the owner set, not a
 * matter of voice. `withoutFlattery` takes a flattering opener off the answer
 * before it is texted, because a prompt asks and this makes sure.
 */

export const OPINION_LINE =
  "You're a coworker with a point of view, not a yes-machine. Before you act on a request to buy, change, rewrite, skip or cut something, check it against their goals (tex/about-me.md), the plan or decision in the note about it, and a shared workspace's mission on its front page. " +
  "If it works against one (cookies against a fitness goal, a rewrite that undoes a decision, skipping a safeguard), your reply's first line names that trade-off in plain words, and for a big change asks what it's for. " +
  "Then still do it: something small or easy to undo now, beside that line; something costly or hard to undo once they say go. After they say go or give a reason, never raise it again. " +
  "A \"should we\" or \"should I\" opens with your take (\"Keep it\", \"I wouldn't\", \"Go for it\") and the reason from their notes, and changes nothing. " +
  "Say nothing for asks that touch no goal, and never lecture or refuse. Never flatter (\"you're so right\", \"great idea\"): when they're right, say you agree in plain words.";

/*
  A sentence that is only flattery, at the very start of the answer:
  "You're so right!", "Great question.", "What a great idea!", "Absolutely!",
  "Love that idea.", or the same clause before a comma ("Absolutely, I'll
  add it" keeps "I'll add it"). A plain "You're right, it's at 3:30" is an
  acknowledgement and stays; the intensified forms are the sycophancy the
  owner named.
*/
const FLATTERY =
  /^\s*(?:(?:oh|ah|ooh|wow)[,!.]?\s+)?(?:you(?:'re| are) (?:so|absolutely|totally|completely|100%|exactly) right|(?:that's |what )?(?:an? )?(?:great|excellent|fantastic|brilliant|amazing|awesome|love(?:ly)?) (?:question|idea|call|point|thought|plan|catch)|absolutely|love (?:that|this|it)(?: idea)?|i love (?:that|this|it)(?: idea)?)(?:,\s*[a-z]+[.!]+|[.!]+|,)\s*/i;

/** `answer` with a flattering opening sentence taken off, unless nothing would be left. */
export function withoutFlattery(answer) {
  if (typeof answer !== "string") return answer;
  const straight = answer.replace(/[‘’]/g, "'");
  const match = FLATTERY.exec(straight);
  if (match === null) return answer;
  const rest = answer.slice(match[0].length).trimStart();
  if (rest === "") return answer;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
