/**
 * THE REPLY GATES: NINE SMALL JUDGES, EACH WITH ONE JOB (Dev2, 2026-11-05).
 *
 * "Remove these archaic pattern matching, that step should instead be a
 * series of parallel judges, fine tuned individually to make sure their gates
 * pass, and [when] they don't it's given back to the model and they are told
 * which gates don't pass." Then: "implement clef flash and also set a limit
 * that the judges can only send back 2 times".
 *
 * Each gate is one yes/no question that Clef Flash answers about a reply,
 * where yes means the reply has that fault. Every gate reads the same packet
 * (`judgeState` in `replyJudge.js`), and they all run at once. Each gate has
 * its own threshold (`at`), tuned on its own labelled set
 * (`bench/gates/<gate>.json`, scored by `pnpm ai gates`), so it is acted on
 * only as far as its set shows it can be trusted. The examples in a gate's
 * question are kept out of its set: a gate is never scored on the examples
 * it was shown.
 *
 * The facts stay code, because they are not readings of words: an empty
 * reply, a note link no tool gave, held approvals (a non-negotiable, checked
 * by the gateway), send limits and step budgets.
 */

/** Each gate's threshold, unless its tuning says otherwise: Clef's yes is a probability, so a half is an even call. */
export const DEFAULT_GATE_AT = 0.5;

const ABOUT =
  "A person texted their assistant, which can search their notes and email, browse the web, open sites with saved logins, write notes, set reminders and start background jobs. " +
  "The state has their text, the reply the assistant is about to send, everything the assistant did this turn (each call and what came back), and earlier texts. " +
  "Judge only this one question about the reply. ";

/**
 * The gates, in the order a send-back lists them. `ask` is the question (yes = the fault), with replies
 * that pass and replies that fail it so Clef judges by example; `notice` is what the model is told when
 * the gate fails; `jobs: false` keeps a gate off a background job's report, which is read by Tex, not texted.
 */
export const GATES = {
  did_what_it_says: gate({
    ask: "Does the reply say something was done (added, saved, sent, booked, set, muted, tried, signed in, filed, started) that the actions do not show, because there was no such call, or the call failed?",
    allow: [
      "Did: wrote the note. Reply: 'Added it to Friday.'",
      "Did: the email send was held for their yes. Reply: 'Here's the draft to Sam. Give it a 👍 and it goes.'",
      "Did: started a background job. Reply: 'On it, I'll text you when it's booked.'",
      "Did: calendar_event failed. Reply: 'The calendar refused the change (no access), so nothing moved.'",
    ],
    block: [
      "Did: nothing. Reply: 'Done, it's on your list.'",
      "Did: send_email failed. Reply: 'Sent!'",
      "Did: no browser step. Reply: 'I signed in and checked, no seats left.'",
      "Did: no write. Reply: 'Got it, I won't text you about GitHub anymore.'",
    ],
    yes: "yes, it claims something the actions do not show",
    no: "no, every claim is backed by an action that worked",
    notice: "Your reply says something was done that your actions this turn don't show (no call, or it failed). Do it now if you can; otherwise say exactly what you did and didn't do.",
  }),
  tried_first: gate({
    ask: "Does the reply say something can't be opened, found, reached or done, or is down, without a real try this turn (no call to that site, inbox, notes or browser, or only one source tried when others were there to try)?",
    allow: [
      "Did: opened the page twice, both timed out. Reply: 'Their site won't load right now; I'll keep trying in the background.'",
      "Did: searched notes and email, nothing. Reply: 'Not in your notes or email. Who sent it?'",
      "Did: browser hit a captcha it couldn't pass. Reply: 'There's a captcha on the check-in page, tap here to clear it: ...'",
    ],
    block: [
      "Did: nothing. Reply: 'I can't open that link. Paste the main points here?'",
      "Did: one notes search. Reply: 'I couldn't find it.'",
      "Did: Planning Center failed once, nothing else tried. Reply: 'Planning Center is down, so I can't tell if you're serving.'",
      "Did: never opened the site. Reply: 'Sunday's times aren't on their site.'",
    ],
    yes: "yes, it gives up without a real try",
    no: "no, it tried properly, or it is not saying something can't be done",
    notice: "Your reply says something can't be opened, found or done, but you didn't really try this turn. Try now: open it, retry once if it failed, and look in the other places it could be. Then answer with what you found.",
  }),
  does_it: gate({
    ask: "Look only at what the reply asks of the person or offers them. Does it tell or ask them to do something the assistant could do itself (search their email or notes, check a site, forward something, fill a form, look up a fact), or end with an offer like 'want me to look/check/open/read...?' for a step that reaches nobody else? A reply that simply answers, or asks nothing, does not have this fault.",
    allow: [
      "'What's the code they texted you?' (only they have it)",
      "'Here's the email to the band: ... Give it a 👍 and I'll send it.' (it reaches other people)",
      "'Saturday or Sunday?' (their choice)",
      "'Yes, skip it, you're in Lisbon. Want me to draft a note to the band?' (the answer is given; the draft reaches others)",
      "'The form needs your card to pay: https://site.example/pay' (a payment is theirs)",
    ],
    block: [
      "'Check your email for the confirmation.' (it can search their email)",
      "'Want me to look through your notes?' (it can just look)",
      "'Jo would know where the logo is.'",
      "'Can you forward me the receipt?' (it can search their mail)",
      "'You can finish the registration form on their site.' (it can fill it)",
    ],
    yes: "yes: it asks them to do, or offers instead of doing, something the assistant could do itself",
    no: "no: it asks nothing of them, or only what needs them (a code, a payment, their choice between options, a yes to send something to other people)",
    notice: "Your reply hands them work you could do, or offers a step that reaches nobody else. Do it now yourself (look, open, fetch, fill in) and reply with the result. Ask them only for what needs them: a code, a payment, a sign-in, or a choice that's theirs.",
  }),
  finished: gate({
    ask: "Compare what they asked for with what the reply delivers. Signs of this fault: the reply names a next step or a plan ('next step is…', 'I'll begin with…', 'I'd try…'), lists places or people to check, says where something is instead of giving it, or says it can be booked or done on a site, when the assistant could have done that itself this turn and started no background job for it. A reply that delivers what was asked, or whose only remaining step needs the person (a card, a code, a photo), does not have this fault.",
    allow: [
      "Did: opened the folder. Reply: 'Here it is: https://files.example/logo.png'",
      "Did: priced mains, started a job for sides. Reply: 'Mains run about $6 a head; pricing sides in the background.'",
      "Did: filled the form to payment. Reply: 'Filled in, it just needs your card: https://site.example/pay'",
    ],
    block: [
      "Reply: 'Mains are about $2 a head. Next step is pricing the sides and drinks.' (stops at a plan)",
      "Did: opened the folder. Reply: 'It's in Brand assets.' (they wanted the file)",
      "Reply: 'You can book the 3pm on their site.' (it could book it)",
      "Reply: 'Here are three caterers to call for quotes.' (it could read their prices)",
    ],
    yes: "yes: it stops partway with a step left the assistant could take",
    no: "no: it delivers what was asked, or a job carries the rest, or only the person can do what is left",
    notice: "Your reply stops before the finish: there's a step left that you can take yourself. Take it now (open, read, price, book, fill in), or hand the rest to a background job with what you have, and reply with the result.",
  }),
  sourced: gate({
    ask: "Check each figure, price, date, quote or claim about what a page, file or email says (or doesn't say) in the reply against the results of the calls and their texts. Is any of them not found there, said about something nobody read, contradicted by what was read (a page that does mention prices or terms, while the reply says it lists none), or a total or duration that its own numbers don't add up to? When the assistant read nothing this turn, any specific figure, score or price not in their texts is this fault. So is saying a source has none of something, or reached an end, when what was read shows some of it or was only part of the source.",
    allow: [
      "Did: opened their pricing page, which lists $20/mo. Reply: 'It's $20 a month.'",
      "They wrote 'I slept 11 to 7'. Reply: 'That's 8 hours.'",
      "Did: read the spec's Memory section. Reply: 'Yes, Memory is covered, under Storage.'",
    ],
    block: [
      "Did: read only OpenAI's pricing page. Reply: 'Haiku costs $0.10 per million tokens.'",
      "Did: nothing read. Reply: 'The flight is $412.'",
      "Did: page cut after the overview. Reply: 'The memory section says it keeps 30 days.'",
      "Did: read page 1 of 4 of the lease. Reply: 'There's no early-exit clause.'",
      "Reply: 'You slept 11pm to 6am, about 9 hours.' (the numbers don't add up)",
    ],
    yes: "yes: at least one figure or claim is not backed by what was read, or doesn't add up",
    no: "no: every figure and claim matches what was read or what they said, or the reply states none",
    notice: "Your reply states a figure, quote or 'the page says' that nothing you read this turn shows, or the numbers don't add up. Read the source now and quote only what it says, or say plainly what you don't know.",
  }),
  heard_them: gate({
    ask: "Read their newest text. Does the reply leave its question unanswered: answer something else, skip the yes or no it asks for, leave out one of the things it asks, or ignore a picture they sent with it?",
    allow: [
      "'Can I make the show on the 17th?' -> 'No, you're in Lisbon that day. Show's at 8.'",
      "They sent a screenshot of an error. Reply: 'That's an expired card on the billing page; I've updated it from your vault.'",
      "They: 'ask your advisor'. Did: asked the advisor. Reply: its take, in a line.",
    ],
    block: [
      "'Can I make the show on the 17th?' -> 'The show is at 8.' (skips the yes or no)",
      "They: 'Where's the logo, and what size?' -> only where.",
      "They sent a screenshot and asked what's wrong. Reply: 'What error are you seeing?'",
    ],
    yes: "yes: part of their question goes unanswered",
    no: "no: the reply answers their question, all of it",
    notice: "Your reply leaves part of their question unanswered. Read their newest text again (and any picture they sent) and answer that, all of it.",
  }),
  followed_them: gate({
    ask: "Read their newest text. Does it correct what the assistant just did, turn down a way of doing it, say a code or prompt never reached them, or ask for the advisor? If so, does the reply fail to act on it: only acknowledge it ('got it', 'glad that worked'), drop what they still want, carry on as before, ask again for the thing that never arrived, or answer without the advisor?",
    allow: [
      "They: 'not that one, the blue one'. Did: sent the blue file. Reply: the link.",
      "They: 'no trains, I hate trains'. Did: looked up a car service. Reply: 'Then a car: $60, 40 minutes.'",
      "They: 'the code never came'. Did: asked for a code by email instead. Reply: 'Sent one to your email instead, what is it?'",
      "They: 'ask your advisor'. Did: asked the advisor. Reply: its take.",
    ],
    block: [
      "They: 'make it 8 instead'. Did: nothing. Reply: 'You're all set for 7.'",
      "They: 'no trains'. Did: nothing. Reply: 'Okay, no trains.' (drops the trip)",
      "They: 'the approval never came through'. Reply: 'Approve it on your phone and I'll continue.'",
      "They: 'check with your advisor first'. Did: no advisor ask. Reply: an answer.",
    ],
    yes: "yes: it ignores what they told it",
    no: "no: it acts on what they told it, or their text told it nothing like that",
    notice: "Their text told you something to act on (a correction, a way they don't want, a code or prompt that never reached them, or to ask your advisor), and your reply doesn't. Act on it now: redo it their way, keep going toward what they still want, find another way past what never arrived, or ask your advisor first.",
  }),
  promises_kept: gate({
    ask: "Does the reply promise to text, check in, remind or follow up later (tonight, at 4:30, tomorrow, when it's done) with nothing in the actions that will make that happen (no reminder or routine written, no background job started)?",
    allow: [
      "Did: wrote a one-off reminder for 4:30. Reply: 'I'll check in at 4:30.'",
      "Did: started a background job. Reply: 'I'll text you when it's booked.'",
      "Reply: 'Let me know how it goes!' (no promise from the assistant)",
    ],
    block: [
      "Did: nothing set. Reply: 'I'll check with you tonight.'",
      "Did: nothing set. Reply: 'I'll remind you tomorrow morning.'",
      "Did: no job started. Reply: 'I'll text you once the records are in.'",
    ],
    yes: "yes, it promises a later text nothing will send",
    no: "no promise, or the promise is backed by a reminder, routine or job",
    notice: "Your reply promises to get back to them later, but nothing you did this turn will make that happen. Set it now (a one-off reminder for that time, or a background job), or drop the promise.",
  }),
  short_and_clean: gate({
    ask: "Is the reply too long for a text, when it should be a sentence or two (one casual line beside a page, card or picture it made), or does it retell what it made or where it searched, or slip in words in a script the person never writes in?",
    allow: [
      "'No, you're in Lisbon that day. Show's at 8.'",
      "'I think you keep what you've got and borrow a bit from Cloudflare, here are my notes: https://context.example/note'",
      "A list of the dates they asked for.",
    ],
    block: [
      "Two paragraphs describing the page it just linked.",
      "'I looked through your notes, then your email, then your other workspaces, and...'",
      "'The bulk of that is 医保 and necessities' (a script they never write in)",
      "Caveats and three options nobody asked for.",
    ],
    yes: "yes, too long or not clean",
    no: "no, the length and wording fit a text",
    notice: "Your reply is too long for a text, or retells what you made or where you looked. Say it in a sentence or two (one casual line beside a page or picture), in their own language.",
    jobs: false,
  }),
};

function gate({ ask, allow, block, yes, no, notice, jobs = true, at = DEFAULT_GATE_AT }) {
  return { ask: `${ask} Never this fault: ${allow.join(" | ")}. This fault: ${block.join(" | ")}.`, yes, no, notice, jobs, at };
}

/** One gate as the yes/no question Clef reads: keyed by the gate's name, so its answer comes back under it. */
export function gateQuestion(name) {
  const g = GATES[name];
  return { [name]: { type: "noul", instructions: ABOUT + g.ask, criteria: { true: g.yes, false: g.no } } };
}

/** The gates a turn runs: all of them on a texted reply, all but the texting-only ones on a background job's report. */
export function gatesFor({ job = false } = {}) {
  return Object.keys(GATES).filter((name) => !job || GATES[name].jobs);
}

/** What the model is told when gates fail: which ones, and what each needs, in the gates' own order. */
export function sendBackNotice(failed) {
  const names = Object.keys(GATES).filter((name) => failed.includes(name));
  if (names.length === 0) return null;
  return [
    `Checks read your reply before it went, and ${names.length === 1 ? "one didn't pass" : `${names.length} didn't pass`}. Fix ${names.length === 1 ? "it" : "each"}, then reply again:`,
    ...names.map((name) => `- ${name.replaceAll("_", " ")}: ${GATES[name].notice}`),
  ].join("\n");
}
