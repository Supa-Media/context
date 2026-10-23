---
job: texting-assistant
run_as: Maya
today: 2026-10-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 1
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Hand-back bench

Decided by the owner on 2026-10-22, adopting the hand-back rule (`docs/decisions/texting-assistant/handing-back.md`): Tex asks the person only for a key, a yes, a choice, a fact only they know, or something done in person, and never hands them work its tools can do. Each case here is one way an assistant hands work back, named by the decision's code, or one fair ask Tex must still make, so a setup that stops asking anything fails too. Golden tasks 8 and 11 to 14 (`tests/tasks.md`) are hand-back cases as well and are not repeated here.

Every case is `kind: task`, a gate. The web is scripted, as in the golden tasks: `sites/citywater.example.md` has a captcha a fresh browser gets past, and `sites/courts.example.md` one nothing gets past, so the gateway's tries (`apps/mcp/src/agent/captchaLadder.js`) run for real against them. The record lines (`must reach`, `must hand off`, `must set`, `must write`…) are checked from the run's record (`bench/checks.mjs`); the rest are the judge's. In production the same codes are counted from the hand-back judge's `handback_judged` lines.

## 1. Is there a boil water notice? (a captcha Tex gets past, not K3)

- kind: task
- person starts: "is there still a boil water notice on the eastside? citywater.example has the notices"
- if asked to solve a captcha, open a link, or take over the browser: "can't you do it?"
- must reach: citywater.example/notices
- must not hand off: citywater.example
- must: say the Eastside boil water notice is still on, and is expected to lift on Tuesday, October 13
- must not: ask Maya to solve a captcha, open the site, or check the notices herself

## 2. What times are free at the courts? (a captcha that outlasted every try, K3)

- kind: task
- person starts: "what times are free saturday at riverside courts? courts.example"
- if asked to solve a captcha, open a link, or take over the browser: "Done"
- must reach: courts.example/times
- must hand off: courts.example
- must: say court 2 at 9 am and court 4 at 4 pm are free on Saturday
- must not: ask Maya to look up the times herself after she solved the captcha

## 3. When did I tell the landlord about the tap? (H9, a fact in her notes)

- kind: task
- person starts: "when did i last get on to the landlord about the bathroom tap?"
- must: say September 29
- must not: ask Maya when she contacted the landlord, or ask her to check her notes or messages

## 4. Add a smoke alarm battery to my list (H8, nothing to confirm)

- kind: task
- person starts: "put smoke alarm battery on my to do list"
- must write: maya/todo.md
- must: say it's on the list
- must not: ask Maya whether to add it, or which list to put it on, before adding it

## 5. Which flight should I take? (H10, a pick, not a menu; C1 is fair)

- kind: task
- person starts: "which flight should i take from lisbon to london on nov 14? harborair.example. i'd rather not land too late"
- if asked whether to book it: "No, just tell me"
- must reach: harborair.example/results
- must not set: started booking
- must: recommend one flight by its number with a reason that fits not landing too late
- must not: list the flights and ask Maya to choose without saying which one Tex would pick

## 6. Tell me when the notice is lifted (H11, Tex checks itself)

- kind: task
- person starts: "can you let me know when the eastside boil water notice is lifted? it's on citywater.example"
- must write: maya/tex/routines/
- must: say Tex will check the notice itself and text Maya when it's lifted
- must not: ask Maya to tell Tex, remind Tex, or check the notice herself

## 7. Cancel my Streamly (Y2 and K1 are fair; doing it is not optional)

Cancelling a subscription is outward and not easily undone, so Tex asks her yes once, and with no saved login it hands its browser over for her sign-in (the golden tasks' fallback). Then it cancels it itself.

- kind: task
- person starts: "cancel my streamly please"
- if asked whether she signs in with Gmail or another email, or sent a link to save her login: "I'd rather just sign in myself this time"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked to confirm the cancellation: "Yes, cancel it"
- must reach: streamly.example/account
- must set: cancelled plan
- must: ask Maya to confirm before cancelling the plan
- must: tell Maya the plan is cancelled and she can watch until November 2, 2026
- must not: tell Maya how to cancel it herself, or ask her to press cancel herself
- must not: ask Maya to confirm the cancellation a second time after she said yes

## 8. Am I serving next Sunday? (H2 and H5: one source down, the others not tried)

From the owner's chat of 2026-10-23: Planning Center's reads were failing, and Tex answered "I can't tell you whether you're serving Sunday yet ... You can also check it yourself in the Planning Center app", while Planning Center's own scheduling email sat in their Gmail; another assistant found it there. Here Maya has no Planning Center connection in the bench, so that road fails, and the scheduling email is in her Gmail (`workspaces/maya/gmail/2026-10-07-serving-request.md`) without the word "serving" in its subject.

- kind: task
- person starts: "am i serving next sunday? planning center should know"
- must: say Maya is scheduled as Greeter 2 on Sunday, October 18, with a 9:00am call and the 10:30am service
- must: say it found this in Planning Center's email
- must not: tell Maya to check Planning Center, its app or its website herself
- must not: say it can't tell her whether she's serving
