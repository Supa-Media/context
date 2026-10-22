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
