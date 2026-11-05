/**
 * THE REPLY JUDGE: A DECISION MODEL BETWEEN TEX AND THE PERSON (Dev2,
 * 2026-11-04, after a customer's group chat where Tex said someone else would
 * know where a logo was, then thanked the customer for naming the folder and
 * did nothing: "a small judge that sits between the interaction agent and the
 * user that just makes sure that no bs gets through").
 *
 * Before a texted reply goes, Clef (`decide.js`) reads what the person asked,
 * the last few texts, every action the turn took (each call with its
 * arguments and what came back) and the reply itself, and answers eight
 * yes/no checks in one call, one per fault (`CHECKS`; Dev2's pick 2026-11-04
 * after one nine-way choice proved near guessing). The fault with the highest
 * yes, at or above `judge_at`, goes back to the model once, with its
 * reason, and the model writes the reply again before anything is sent. The
 * second reply is sent as it is: one retry, never a loop (Dev2's pick, the
 * same day).
 *
 * Why a decision model and not a pattern over the words: the owner rejected
 * phrase-pattern checks on reply quality the same day ("pattern is not the
 * right fix"). Clef reads meaning, answers yes or no with a probability (typed
 * by construction, nothing to parse), and is fast enough to sit in front of
 * every reply. A yes below the setup's `judge_at` is not
 * acted on, and a judge that fails or times out is no verdict: the reply goes.
 *
 * Turned on per setup with `reply_judge: clef` or `reply_judge: clef-flash`
 * (`production.js`), so the benchmark measures it against production before
 * it goes live.
 */

import { decisionEngine, decisionTokens } from "./decide.js";

/** The decision models a setup may name, by the word it uses. */
export const JUDGE_MODELS = {
  clef: { model: "@cf/cloudflare/clef", selector: "clef" },
  "clef-flash": { model: "@cf/cloudflare/clef-flash", selector: "clef-flash" },
};

/**
 * A check is acted on when Clef's yes reaches this, unless the setup says otherwise. Clef answers each
 * check yes or no with a probability, so a half is an even call (Dev2's pick 2026-11-04: one nine-way
 * choice spread its confidence near evenly over the verdicts in rounds gh-168 and gh-170).
 */
export const DEFAULT_JUDGE_AT = 0.5;

/** The judge never holds a reply longer than this; past it, the reply goes. */
export const JUDGE_TIMEOUT_MS = 3_000;

/** The most the judge reads, in characters; the reply and the ask come first, so nothing that matters is cut. */
const MAX_STATE_CHARS = 16_000;

/**
 * The yes/no checks Clef answers about the reply, each on its own: yes means the reply has that fault.
 * One call asks them all; the fault with the highest yes, at or above `judge_at`, sends the reply back.
 */
export const CHECKS = {
  not_started: check(
    "Did the assistant skip the work: answer 'couldn't find it', ask where something is, or promise to look, without really looking first (more than one place: notes, email, the chat, the web, a site or folder they named) and without starting a background job?",
    {
      allow: [
        "Did: searched notes, searched email, opened the site. Reply: 'Found it: https://files.example/logo.png'",
        "Did: searched notes, started a background job. Reply: 'Not in your notes, so I've got a job digging through Dropbox. I'll text you when I have it.'",
        "Did: searched notes and email. Reply: 'Not in your notes or email. Where do you keep it, Drive or Dropbox?'",
        "Did: opened the page, it failed twice, started a job. Reply: 'Filebox won't load right now, I'll keep trying in the background.'",
        "Did: read the calendar. Reply: 'Nothing Friday.'",
      ],
      block: [
        "Did: nothing. Reply: 'I couldn't find it.'",
        "Did: one notes search. Reply: 'Not in your notes.'",
        "Did: nothing. Reply: 'Where do you keep it?'",
        "Did: searched notes, no job started. Reply: 'I'll look into it.'",
      ],
    },
    ["yes, it skipped the work", "no, it looked properly, or started a job, or nothing needed doing"],
  ),
  not_finished: check(
    "Did the work stop short of what they wanted, with a step left the assistant could take itself (give the file's own link, open the page, book it, read to the answer), not taken and not handed to a background job?",
    {
      allow: [
        "Did: opened the folder. Reply: 'Here it is: https://files.example/club/brand/logo.png'",
        "Did: opened the folder, started a job for the print version. Reply: 'Here's the logo: https://files.example/logo.png. Pulling the print version in the background.'",
        "Did: filled the form up to payment. Reply: 'Form's filled, it needs your card to submit: https://site.example/pay'",
      ],
      block: [
        "Did: opened the folder. Reply: 'Found it, the green one on white.' (no link to the file)",
        "Did: opened the folder. Reply: 'It's in Brand assets on Filebox.' (the folder, when they wanted the file)",
        "Did: found the booking page. Reply: 'You can book at 3 on their site.' (it could book it)",
        "Did: read half the thread. Reply: 'Looks like they're still deciding.'",
      ],
    },
    ["yes, it stopped short", "no, it finished, or handed the rest to a job, or what is left needs them"],
  ),
  offered_instead: check(
    "Does the reply offer, or ask permission, to do something the assistant could just do now and that reaches nobody else?",
    {
      allow: [
        "'Done, it's on your list for Friday.'",
        "'Here's the email to Sam: ... Say yes and I'll send it.' (it reaches another person, so it waits for a yes)",
        "'Want the Saturday or the Sunday slot?' (their choice)",
      ],
      block: ["'Want me to keep looking?'", "'Should I check your email?'", "'I can search the web for it if you like.'", "'Want me to open the folder?'"],
    },
    ["yes, it offers instead of doing", "no such offer"],
  ),
  only_acknowledged: check(
    "Did their text give something an earlier ask needed (where a file is, which site, which one, an answer to the assistant's question), and the reply only thanks or acknowledges it, with nothing done with it this turn?",
    {
      allow: [
        "They: 'it's in dropbox under brand assets'. Did: opened it, wrote the note. Reply: 'Got it: https://files.example/logo.png. Saved where it lives in your club notes.'",
        "They: 'it's in dropbox'. Did: checked the vault, no login. Reply: 'I can't get into Dropbox without a login. Add one here and I'll grab it: https://context.example/vault'",
        "They: 'the blue one'. Did: sent the blue file. Reply: the link.",
      ],
      block: [
        "They: 'it's in dropbox under brand assets'. Did: nothing. Reply: 'Thanks, that helps.'",
        "Same. Did: nothing. Reply: 'Got it, I'll remember that.'",
        "Same. Did: nothing. Reply: 'Perfect, thanks!'",
      ],
    },
    ["yes, it only acknowledged what they gave", "no, it acted on it, or their text gave nothing an ask needed"],
  ),
  sent_elsewhere: check(
    "Does the reply push work back onto them, or onto someone else, that the assistant could do itself?",
    {
      allow: [
        "'What's the code they texted you?' (only they have it)",
        "'Did you already pay the balance?' (only they know)",
        "'I can't text Mina, but here's one you can send: Bringing soup Sunday!' (it can't, and gives the next best thing)",
        "'Here's the draft to the band: ... Say yes and I'll send it.' (it reaches other people)",
        "Did: searched notes and email. Reply: 'Not in your notes or email. Who sent it?' (looked first, then asked)",
      ],
      block: [
        "'Jo would know where it is.'",
        "'You can download it from Filebox.' (it can open Filebox)",
        "'Can you send me the file?' (they said where it lives, or it never looked)",
        "'Check your email for it.' (it can search their email)",
      ],
    },
    ["yes, it pushes work back that the assistant could do", "no, or the hand-back is one of the fine kinds"],
  ),
  unbacked_claim: check(
    "Does the reply say something was found, opened, saved, sent, booked, started or done that the actions do not show (no such call, or the call failed)?",
    {
      allow: [
        "Did: wrote the note. Reply: 'Saved.'",
        "Did: started a background job. Reply: 'On it, I'll text you when it's done.'",
        "Did: the send was held for their yes. Reply: 'Here's the draft. Say yes and it goes.'",
      ],
      block: [
        "Did: nothing. Reply: 'Found it.'",
        "Did: wrote nothing. Reply: 'Saved it to your notes.'",
        "Did: the send failed. Reply: 'Sent!'",
        "Did: no job started. Reply: 'Working on it in the background.'",
      ],
    },
    ["yes, it claims something the actions do not show", "no, every claim is backed by an action"],
  ),
  wrong_question: check(
    "Does the reply answer a different question from the one they asked, or leave out part of it?",
    {
      allow: [
        "'Can I make the show on the 17th?' -> 'No, you're in Lisbon that day. The show is at 8.'",
        "'What do I need before Lisbon?' -> a short list of exactly those to-dos.",
      ],
      block: [
        "'Can I make the show on the 17th?' -> 'The show is at 8, load-in 6:30.' (skipped the yes or no)",
        "'Where's the logo and what size is it?' -> only where it is.",
      ],
    },
    ["yes, it misses what they asked", "no, it answers what they asked"],
  ),
  too_verbose: check(
    "Is the reply wordy when it should not be? A text answers in a sentence or two; more is fine only when it is the detail they asked for.",
    {
      allow: [
        "'No, you're in Lisbon that day. The show is at 8, load-in 6:30.'",
        "'Physio on the 20th, and the credenza glue-up is planned that day.'",
        "'Found it: https://files.example/logo.png'",
        "A list of the dates, items or steps they asked for.",
      ],
      block: [
        "'I looked through your notes, your email and your other workspaces, and...' (retelling where it searched)",
        "Two paragraphs where one line answers.",
        "Repeating what they just said, or caveats and options nobody asked for.",
        "'My earlier \"can't find it\" was wrong because...' (explaining itself)",
      ],
    },
    ["yes, wordy when it should not be", "no, the length fits what they asked"],
  ),
};

/** One check: the question, then replies that pass and replies that fail it, so Clef judges by example (Dev2, 2026-11-05). */
function check(ask, { allow, block }, [yes, no]) {
  return {
    ask: `${ask} Never this fault: ${allow.join(" | ")}. This fault: ${block.join(" | ")}.`,
    true: yes,
    false: no,
  };
}

/** What the model is told for each verdict, before it writes the reply again. */
export const VERDICT_NOTICES = {
  not_started:
    "A check read your reply against what you did this turn and found the ask not done: you stopped before really trying. Do it now: look in the other places it would be (their email, this chat's earlier texts, the web, a site or folder they named), or hand it to a background job with everything you know. Then reply with what you found.",
  not_finished:
    "A check found steps left that you can take yourself. Take them now (open the page, follow the folder, read the file, finish it), or hand the rest to a background job with everything you've found, and reply with the result.",
  offered_instead:
    "A check found your reply offers to do something you can just do, and it reaches nobody else. Do it now and reply with the result, not a question about it.",
  only_acknowledged:
    "A check found they gave you what the earlier ask needed, and your reply only acknowledged it. The ask continues: act on what they told you now, keep it in the note it belongs in, and reply with the result.",
  sent_elsewhere:
    "A check found your reply sends them to someone else or tells them to do it themselves. Do it yourself first: look, open, fetch. Hand back only what truly needs them (a sign-in code, a payment, a choice that's theirs).",
  unbacked_claim:
    "A check found your reply says something was done or found that your actions this turn don't show. Do it now if you can, or say exactly what you did and didn't do.",
  wrong_question:
    "A check found your reply doesn't answer what they asked, or misses part of it. Read their text again and answer that, all of it.",
  too_verbose:
    "A check found your reply too long for a text. Say the same thing in a sentence or two: the answer or result first, nothing they already know, no list of steps.",
};

const ABOUT =
  "A person texted their assistant, which can search their notes and email, browse the web, open sites with saved logins, write notes and start background jobs. " +
  "The state has their text, the reply the assistant is about to send, everything the assistant did this turn, and earlier texts. Judge only the reply against what they asked and what was done. ";

const QUESTIONS = Object.fromEntries(
  Object.entries(CHECKS).map(([name, check]) => [
    name,
    { type: "noul", instructions: ABOUT + check.ask, criteria: { true: check.true, false: check.false } },
  ]),
);

/** One line per action the turn took: each call with its arguments, then what came back, both cut short. */
export function actionsOf(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) lines.push(`- called ${String(call?.name ?? "?")} ${clip(argsText(call?.args), 300)}`);
    } else if (message?.role === "tool") {
      lines.push(`  ${message.isError === true ? "failed" : "returned"}: ${clip(String(message.text ?? ""), 400)}`);
    }
  }
  return lines;
}

/** What Clef reads: the ask and the reply first, then every action, then the earlier texts. */
export function judgeState({ question, history = [], messages = [], answer }) {
  const actions = actionsOf(messages);
  const earlier = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((turn) => `${turn?.role === "assistant" ? "Assistant" : "Person"}: ${clip(String(turn?.text ?? ""), 600)}`);
  return [
    `Their text now: ${clip(String(question ?? ""), 3_000)}`,
    "",
    `The reply about to be sent: ${clip(String(answer ?? ""), 3_000)}`,
    "",
    `What the assistant did this turn (${actions.length === 0 ? "nothing: no searches, reads or other actions" : `${actions.filter((line) => line.startsWith("- ")).length} actions`}):`,
    ...actions,
    "",
    "Earlier texts in this chat, oldest first:",
    ...(earlier.length === 0 ? ["(none)"] : earlier),
  ]
    .join("\n")
    .slice(0, MAX_STATE_CHARS);
}

/**
 * `{ check, verdicts }` for `runTurn`'s `answerCheck`, around the turn's other
 * check (`doItChecks.js`, `claimCheck.js` or `untriedWeb.js`), which runs first.
 * `check(answer, { messages })` judges once a turn; `verdicts` keeps what each
 * judging decided, for the turn's log and the benchmark.
 */
export function replyJudge({ ai, setting, question, history = [], inner = null, clock = Date.now, log = console.log }) {
  const pick = JUDGE_MODELS[setting?.model];
  const decide = pick ? decisionEngine(ai, pick) : null;
  const at = typeof setting?.at === "number" ? setting.at : DEFAULT_JUDGE_AT;
  const verdicts = [];
  let judged = false;
  return {
    verdicts,
    async check(answer, turn = {}) {
      const before = typeof inner?.check === "function" ? await inner.check(answer, turn) : null;
      if (before !== null && before !== undefined) return before;
      if (judged || decide === null) return null;
      judged = true;
      const state = judgeState({ question, history, messages: turn.messages, answer });
      const started = clock();
      const answers = await withTimeout(decide(state, QUESTIONS), JUDGE_TIMEOUT_MS);
      const ms = clock() - started;
      const { verdict, confidence } = worstOf(answers, at);
      const acted = verdict !== null && verdict !== "accepted";
      verdicts.push({ verdict, confidence, ms, acted, tokens: decisionTokens(state, QUESTIONS) });
      turn.mark?.({ verdict, confidence, ms, acted, ok: verdict !== null });
      // Ids and numbers only: never the reply or the question (`docs/decisions/observability`).
      log(JSON.stringify({ event: "tex_reply_judge", model: pick.model, verdict, confidence, ms, acted }));
      return acted ? VERDICT_NOTICES[verdict] : null;
    },
  };
}

/** `reply_judge:` in a setup: absent is off; `clef` or `clef-flash` names the judge; anything else refuses the setup (`undefined`). */
export function readReplyJudge(value, at) {
  if (value === undefined || value === "off" || value === false) return at === undefined ? null : undefined;
  if (typeof value !== "string" || !(value in JUDGE_MODELS)) return undefined;
  if (at === undefined) return { model: value, at: DEFAULT_JUDGE_AT };
  if (typeof at !== "string" || !/^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/.test(at)) return undefined;
  return { model: value, at: Number(at) };
}

/**
 * The fault with the highest yes, when it reaches `at`; otherwise `accepted`, with that highest yes as
 * its confidence (how near the reply came to going back). No yes/no answered at all is no verdict.
 */
export function worstOf(answers, at) {
  let worst = null;
  for (const name of Object.keys(CHECKS)) {
    const yes = answers?.[name]?.noul;
    if (typeof yes !== "number" || !Number.isFinite(yes)) continue;
    if (worst === null || yes > worst.confidence) worst = { verdict: name, confidence: yes };
  }
  if (worst === null) return { verdict: null, confidence: null };
  return worst.confidence >= at ? worst : { verdict: "accepted", confidence: worst.confidence };
}

function argsText(args) {
  try {
    return typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    return "";
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
