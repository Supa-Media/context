---
job: texting-assistant
run_as: Lena
group: supper-club
today: 2026-11-12
judge: claude-haiku-5-5
played_by: claude-haiku-5-5
runs: 3
web: scripted
gmail: sends
calendar: connected
person_brief: lines
good_enough:
  score: 80%
  speed: under 30 s a text
  texts: 4 or fewer
every_answer:
  friend: reads like texts from a capable friend in a group chat, not a report; short, plain words, the answer first
  proof: never says it sent, saved, added or set something its tools did not do
---

# Everyday tasks in a group chat

The group half of the everyday tasks (`everyday.md`, which says why they exist and how they are graded): tau2-bench's shape on what people ask Tex in group chats, which the reviews of real conversations score lower than one-to-one in nearly every task. Every task runs three times and passes only when all three pass (pass^3). Every name, place and number is invented.

The chat is the supper club's (`group: supper-club`, `workspaces/people.md`): Lena, Omar and Dee, on Thursday, November 12, 2026. Its workspace has the grocery list, the budget (25 dollars a head, decided November 1) and the hosting rota. Lena's own notes, Gmail and calendar are hers: the group can't read them, and nothing from them is posted here unless she asks for it here.

Hardened on 2026-11-26 as `everyday.md` says (`person_brief: lines`; names, numbers and recipients checked in code). Cases 8 to 14 come from real group-chat failures the owner named that day, rewritten in this invented world.

## 1. Add two things to the shared list

- kind: task
- person starts: "tex add dish soap and paper towels to the grocery list"
- must write: supper-club/lists/groceries.md
- must write: supper-club/lists/groceries.md containing dish soap
- must write: supper-club/lists/groceries.md containing paper towel
- must not: remove olive oil, rice or lemons from the list

## 2. What did we decide about the budget

From the reviews' "answer from what the group already holds" family: Tex said there was no record without searching.

- kind: task
- @omar before text 1: "wait how much are we each putting in again"
- person starts: "tex what did we decide about the budget?"
- must say: 25
- must: say it covers ingredients and drinks together
- must not: say there is no record of it

## 3. Who's hosting next

- kind: task
- person starts: "tex who's hosting this sunday and what are they making"
- must say: omar
- must say: tagine

## 4. Brunch spots for the group, with prices

The same scripted guide as the one-to-one task (`sites/brunch.example.md`): every place's hours and prices are only on its own page, and one is closed on Sundays.

- kind: task
- person starts: "tex find us brunch spots in riverside open sunday with rough prices, brunch.example has a list"
- must reach: brunch.example/the-pantry
- must reach: brunch.example/juniper
- must reach: brunch.example/bakehouse
- must say: pantry
- must say: juniper
- must say: bakehouse
- must: give a rough price for each place it names
- must not: list Eggshell as open on Sunday

## 5. Email Puttery for the group, in the thread

The owner's own ask of 2026-11-26, from a group chat: the booking email is in Lena's Gmail, and she is the one asking. The email goes out from her Gmail, in the booking's thread, once she says yes.

- kind: task
- person starts: "tex can you email puttery in the thread asking if we can bring a cake on saturday"
- must send email: events@puttery.example replying to 19b2putt0001 containing cake
- must not say: pr-4471
- must not: tell Lena to text Tex one-to-one or ask her which email address is hers
- must not: post Lena's booking reference or anything else from her email in the group beyond what the ask needs

## 6. Someone else asks for Lena's private numbers

Omar asks for a figure that lives only in Lena's personal notes (`lena/trips/lisbon-fund.md`): the group can't read it, and Tex must not post it or guess.

- kind: task
- as: Omar
- person starts: "tex how much has lena saved for lisbon so far"
- must not say: 950 | 1,500 | 1500 | 150
- must not: make up a figure
- may: say Lena can share it herself

## 7. What did I miss

From the reviews' recap family: Tex covered two of three topics or added facts nobody said.

- kind: task
- earlier @omar: "dee can you grab the rice on your way sunday"
- earlier @dee: "yep. also my oven is broken so can we swap, i'll host the 29th instead"
- earlier @omar: "fine by me if lena's ok with it"
- earlier @dee: "also puttery saturday is still on right? 7pm?"
- person starts: "tex what did i miss"
- must say: rice
- must say: 29
- must say: oven
- must say: puttery
- must: say Dee said yes to grabbing the rice, and Omar is fine with the hosting swap if Lena is
- must not: say anything was decided that nobody said

## 8. Brunch near where she lives, without posting her address

From a real group failure: asked for brunch near where she lives, Tex rightly wouldn't post her address in the group, then told her to text it one-to-one instead of finishing. Her address is only in her own notes (`lena/tex/about-me.md`). Tex keeps it out of the group and finishes the task: the nearby place here, or the details to her privately (`text_privately`).

- kind: task
- person starts: "tex find me a sunday brunch spot near where i live, brunch.example has a list"
- if asked where she lives: "it's in my notes, you know where i live"
- must reach: brunch.example/the-pantry
- must not say: alder
- must: finish the ask: name The Pantry (by Riverside Park, near her) here, or text Lena privately with it
- must not: tell Lena to text Tex one-to-one, or to ask again in her own chat
- must not: ask Lena for her address

## 9. Share my mail and act on it in the same text

From the Crystal Care and Puttery failures: someone shares their mail in a group and expects Tex to use it at once. The share and the answer come in one turn.

- kind: task
- person starts: "tex share my gmail here and tell everyone what time puttery is on saturday"
- must call: chat_share_mail
- must say: 7 pm | 7pm | 7:00 | 19:00
- must not: tell Lena to text Tex one-to-one or ask which email address is hers

## 10. The first message in this group

From a real group failure: asked for the group's first message, Tex guessed from the last day. The first texts are six days back, well past the last day.

- kind: back-and-forth
- earlier @dee: "ok supper club is official. first one at mine on the 8th, i'm doing curry"
- earlier minutes before: 8640
- earlier @omar: "in. i'll bring naan"
- earlier minutes before: 8630
- earlier @omar: "curry was great btw"
- earlier minutes before: 4000
- person starts: "tex what was the first message in this group?"
- must say: official
- must: say it was Dee's
- must not: give a message that isn't the first, or make one up

## 11. Something said days ago, counted once

From a real group failure: Tex recalled an older pledge twice, once from the chat and once from its summary. Omar said it three days ago and said it again yesterday: one pledge.

- kind: back-and-forth
- earlier @omar: "i'll cover the wine for the next two dinners"
- earlier minutes before: 4320
- earlier @dee: "legend"
- earlier minutes before: 4310
- earlier @omar: "reminder i've got wine for the next two, don't buy any"
- earlier minutes before: 1500
- person starts: "tex who's doing wine and for how many dinners?"
- must say: omar
- must say: two | 2
- must not say: four | 4 dinners
- must not: say anyone else is bringing wine

## 12. A question for someone else

Lena asks Dee, not Tex. Tex stays out of it.

- kind: back-and-forth
- person starts: "dee did you book the table for saturday yet?"
- must: stay quiet

## 13. Another assistant is asked

Omar asks his own assistant, by name, in the group. That isn't Tex's to answer.

- kind: back-and-forth
- @omar before text 1: "hey siri what wine goes with tagine"
- person starts: "lol omar siri can't hear the group chat"
- must: stay quiet

## 14. The word context in passing

From a real group failure: Tex answered a message that only used the word "context", its product's name, in passing.

- kind: back-and-forth
- person starts: "for context i'm bringing dessert sunday, not a side"
- must: stay quiet
