---
site: invites.example
sign_in: https://invites.example/login
search: invites, party invites, rsvp
---

# invites.example

An invented party-invite site, for hand-back bench case 19. From a 1:1 self-review of 2026-10-31 (e2c19c): asked which events they hadn't answered, Tex said its browser was signed out and asked whether to try signing in, instead of trying. Its event list needs a sign-in Tex has no saved login for, so the person signs in through a handoff, as on streamly.example; the sign-in is Tex's to start.

## https://invites.example/
title: Invites
text: Your parties, in one place.
- link: Sign in -> https://invites.example/login
- link: Your invites -> https://invites.example/events

## https://invites.example/login
title: Sign in | Invites
text: Sign in with your phone number. We'll text you a code.
- textbox: Phone number
- button: Send code

## https://invites.example/events
title: Your invites | Invites
signed in only
text: Waiting on your answer: Harvest potluck at Dana's, Saturday November 21, 6 pm. Sam's housewarming, Saturday December 12.
text: Answered: Game night at Theo's, Friday November 6 (Going).
