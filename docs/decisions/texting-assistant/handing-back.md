# Tex asks the person only for a key, a yes, a choice, a fact or a body (2026-10-22)

On 2026-10-22 the owner adopted a hand-back rule after three failures in one
day. In the first, Tex found a receipt and then texted "Forward Google's receipt … to me" and
"Check Google Voice's billing history". In the second, it told the owner it couldn't open a Bible
passage it had not tried to open, then that it couldn't say where the text came
from. In the third, it found an invoice and texted "Tap the download arrow … attach it to the
draft". The owner: "the only things Tex should be handing back is permission
stuff, or high level decision making … never hand". The full design, with
use cases, is the "Tex Handback Policy" page linked from
`@supa projects/tex/handoff/handback-evaluation-design.md`.

**The rule.** Tex does every step its tools can reach. It asks the person only
for something it cannot take:

- **a key**: a sign-in with no saved login, a code or approval on their phone,
  a captcha that outlasted every try (below);
- **a yes**: money, anything that cannot be undone, anything that speaks for
  them to someone else, consent to terms, access or a security change;
- **a choice** on their taste, values or priorities, with Tex's own pick;
- **a fact** only they know, after notes, mail, calendar and the web were
  searched, asked once and then remembered;
- **a body**: something only they can do in person, with everything around
  it booked and ready.

Before asking, Tex does all the work around the blocker and asks once. A yes
is never asked twice, and Tex fixes its own mistakes without asking.

**The codes.** The hand-back check, the bench and the production counts all
report the same codes:

- **H1–H12, never asked:**
  - H1 "send me it"
  - H2 "go and look"
  - H3 last-mile clicks (download, attach)
  - H4 instructions instead of doing
  - H5 "can't" without trying
  - H6 doubting or taking back what it read
  - H7 re-asking after a yes, or asking leave to fix its own mistake
  - H8 confirming something reversible
  - H9 asking what it could find
  - H10 a menu instead of a pick
  - H11 a follow-up pushed to the person
  - H12 dropping the job
- **K1–K3, Y1–Y3, C1–C2, F1, B1, fair asks:**
  - K1 sign-in, K2 code or approval, K3 captcha
  - Y1 money, Y2 irreversible or outward, Y3 consent or security
  - C1 a choice on taste, C2 colliding priorities
  - F1 a fact only they know
  - B1 something done in person

## A small model reads an answer that asks them something

A phrase can show "forward me the receipt" (`claimCheck.js` `handsWorkBack`),
but it can't show "which receipt does she need?". That sentence is a
hand-back only because the receipt is in their mail. So a texted answer that
may ask the person something (a question mark, "text me", "you'll need to"…)
is read by a small model, the hand-back judge (`apps/mcp/src/agent/handbackJudge.js`,
Haiku, `HANDBACK_JUDGE = "on"`). The judge is told what Tex can do. It reads
the person's text, the answer, and the names of the tools this turn ran with
ok or failed. It labels each ask with the codes above. An H-code sends the
answer back once, with a notice written for that code. For H11, for example,
the notice says to write a routine note and check it itself.

It never reads a tool's result, a note, a page or an email, so nothing a
stranger wrote can steer it. It can only ask for more work, never let
through an answer another check stopped. When it can't run, the answer goes
as it is. Each verdict is logged as `handback_judged` with codes only, never
words: that is the production hand-back rate.

**What a simplification would cost.** Without the judge, the only
hand-backs caught are those a fixed phrase can show. The H9, H10 and H11
asks, which are most of the "typical" column in the design's use cases, go
out. If the judge were shown tool results, any email or page could tell it
an ask was fair.

**Tests.** `apps/mcp/test/agentHandbackJudge.test.mjs`: strict reading,
which answers are judged, one notice per code, codes-only logging, never a
result, once a turn, and `runTurn` awaiting it. Sabotage record in its
header.

## A captcha is the person's only after every way past it was tried

The owner, the same day: "make sure agents try using those bypasses and other
browserbase hacks before handing back". Browserbase solves captchas itself in
every browser. Its browsers start with residential proxies and advanced
stealth where the plan has them ([computer](./computer.md)). So a captcha
goes through three tries before it reaches the person, and the gateway runs
them, not the model:

1. **The solver's wait.** After every Browserbase run, the screenshot Worker
   looks for a captcha widget whose answer box is still empty, or a whole-page
   bot wall, and waits up to 30 seconds for it to clear
   (`infra/site-shots/src/captcha.ts`). The probe returns three booleans and
   never the page's words. It never enables the Runtime domain, which is a
   known bot-check tell.
2. **A reload.** If the captcha stays, the browse tool opens the same page
   again: a new challenge, and the solver gets another go
   (`apps/mcp/src/agent/captchaLadder.js`).
3. **A fresh browser.** The Worker lets the person's browser go and starts a
   new one (`fresh: true`), with a new address and fingerprint and the
   person's sign-ins put back from their jar.

Only a captcha that outlasts all three may be handed over (K3), and the
reading then says so. A handoff the model asked for runs its steps first
without the handoff, so a captcha met on the way gets the tries. If the
tries clear it, nothing is handed over. One question runs the tries on at
most two pages. An answer that asks the person to solve a captcha, on a turn
where none outlasted the tries, goes back to the model once
(`claimCheck.js` `CAPTCHA_NOTICE`).

**What a simplification would cost.** If the tries were only asked of the
model in the prompt, a model that sees a captcha would hand it over, which
is exactly what the owner asked to stop. If the probe returned the page's
words, a page could write into the gateway's logs and the model's notices.
If the claim check were dropped, an answer could still tell the person "tap
the link and solve it" in its own words without asking for a handoff.

**Tests.**
- `apps/mcp/test/agentCaptcha.test.mjs`: reload, fresh browser, stuck,
  a sign-in handoff with no tries, the per-question bound, `fresh` sent to
  the Worker, and the answer check.
- `infra/site-shots/src/captcha.test.ts`: the probe's signs, the solver's
  wait, and booleans only.
- `infra/site-shots/src/browserbase.test.ts`: a fresh browser lets the
  running one go.

Each guard was sabotage-tested; the record is in the gateway test's header.

## What went out is read again each night

The judge reads an answer before it goes, and may send it back once, so
what a person was really texted can still hand them work: a second answer
the judge never saw, or one it let through. So once a night, after the
dream, the gateway reads the texted turns the dream's transcripts hold since
the last dream (`apps/mcp/src/agent/handbackMiner.js`). It is the gateway,
never a model with tools, and it reads at most 30 answers a night, only
those that may ask something. Each goes to the same judge, with the person's
text and the names of the tools the turn ran. What it finds goes in the
person's own `tex/handbacks/YYYY-MM-DD.md`: the time, the code and the
judge's quote of Tex's words. It is theirs to read and delete, like the
transcripts. The Worker's log gets `handbacks_mined` with counts by code
only, which is the count across people. A turn's id carries when it began,
so no turn is counted twice. It runs where `HANDBACK_JUDGE = "on"`.

**What a simplification would cost.** Counting only the judge's verdicts
before sending measures what the model first wrote, not what reached the
person. If the miner were given the transcript's tool arguments, a page's
or an email's words typed into a search could steer it. A shared results
note written from each person's dream would carry one person's facts into
a workspace they don't belong to, so the log carries counts only.

**Tests.** `apps/mcp/test/agentHandbackMiner.test.mjs`, on transcripts
written by the real `openTranscript`: turns read back with routines left
out, the note, tool names but never arguments, counts-only logging, no turn
counted twice, and a failing judge. Sabotage record in its header.

## When one source fails, the others first

Decided by the owner on 2026-10-23 ("be more like dot"). Planning Center's
reads were failing, and Tex answered "I can't tell you whether you're
serving Sunday yet ... You can also check it yourself in the Planning
Center app". Planning Center had emailed the schedule to their Gmail days
before, and another assistant found it there and texted them unasked. None
of the hand-back guards caught it: the answer had no question mark, so the
judge never ran (`mayAsk`), and "you can also check it yourself" slipped
past every phrase.

So a failed source is never the end of a question. Every texted turn is
told to get the same answer another way first (`OTHER_ROUTES_LINE`: apps
email what they hold, so their mail from that app; their calendar; their
notes; the app's website in the browser), and to say where it read the
answer. An answer that gives up on a turn where a call failed, or that says
a source is down, gets one more round naming the roads that turn didn't take
(`apps/mcp/src/agent/otherRoutes.js`). An answer that promises to text later,
with no routine written and no job started in the turn, gets one more round
telling Tex to write the hourly routine (with `until:`) that keeps the
promise and answers in that same chat; that text answers their question, so
it is a reply, never texting first. "Check it yourself" in an app or on a
site is a hand-back like any other, link or not, and an answer that says it
can't tell them is judged.

**What a simplification would cost.** Treating a failed app as "can't
answer" hands the person a lookup Tex's mail search does in a second, and a
promise with nothing behind it is a text that never comes. Reading only the
answer, without the turn's failed calls, would send back every honest "your
notes don't have his number".

**Tests.** `apps/mcp/test/agentOtherRoutes.test.mjs` (the owner's own text,
roads named by what the turn skipped, the promise kept by a routine or a
job, a scripted turn that finds the serving email); bench case 8 in
`bench/ai/tests/handback.md`. Sabotage record in the test's header.

## A grocery order, handed back four ways (2026-10-24)

A texted Instacart order (from Tex's own self-review report) went wrong four
ways. Tex typed a Gmail address it found into Instacart's email-first
sign-in, not the login saved for instacart.com; handed over a "picture check"
it had been answering itself; texted "the cart won't open in my browser"
four times and told the person to change the cart in the Instacart app,
until a plain retry worked; and sent its browser for the saved card because
the card boxes were in Stripe's frame.

- **The saved login's email.** `fill_login` takes `username_ref` alone for
  a page that asks for the email first. `browse` refuses to type an email the
  person never wrote on a site they have a login saved for, and names
  `fill_login` (`guessedSignInEmail`, `apps/mcp/src/agent/browse.js`).
- **The captcha ladder gets its time.** Browse calls were cut at 30 s, but
  the Worker alone waits 30 s for Browserbase's solver before the reload and
  the fresh browser (`captchaLadder.js`), so the ladder never finished and the
  model was told "don't retry it". Browse now gets 160 s
  (`apps/mcp/src/agent/route.js`). The probe knows "confirm you're human",
  "select all images" and AWS WAF's frame, and an answer handing over a
  "picture check" is read as handing over a captcha.
- **A stumble is retried.** A browse call that ran long is told the browser
  is still where it got to and to run the rest again (`turn.js`); one whose
  run threw reads where the browser is instead of saying it couldn't; and an
  answer that gives up after the turn's last browser call failed gets one
  round saying to run it again first (`BROWSER_RETRY_NOTICE`,
  `claimCheck.js`).
- **The cart is Tex's.** "In the Instacart app, remove ..." and "you can
  remove ... in the app" are hand-backs (`APP_HANDBACK`); a payment, a code
  or a tap on their phone stays theirs.
- **The card fills in the processor's frame.** See the vault note's
  "Payment frames".

**What a simplification would cost.** Letting the model type any email puts
a guessed account into a sign-in and spends the person's patience on "that's
literally not the account I saved". Cutting browse back to 30 s means every
captcha is handed over untried.

**Tests.** `apps/mcp/test/agentInstacartCheckout.test.mjs`,
`apps/mcp/test/agentFillLogin.test.mjs` (email-first and found-email cases),
`apps/mcp/test/agentTurnLimits.test.mjs`,
`infra/site-shots/src/paymentFrames.test.ts` and `captcha.test.ts`. Sabotage
records in the tests' headers.

## A page is blocked only after this turn tried it (2026-10-24)

In a group chat Tex texted "the browser still won't open claude.ai/login from
this chat" and "the browser refused the address" four times, in turns where no
browser step ran at all, then signed in at the first real try. The answer
check now sends back any answer that gives up on the browser or calls a page
blocked: after a failed browser call it says to run it again (and, for a
refused address, to search for the page and open the result); with no browser
call this turn, while the turn has a browser, it says to try it now. Once a
turn, like the other notices. Dropping either branch would let "won't open"
stand on an earlier turn's failure, which is the behaviour this replaces.

**Tests.** `apps/mcp/test/agentBrowserUntried.test.mjs`, sabotage record in
its header.
