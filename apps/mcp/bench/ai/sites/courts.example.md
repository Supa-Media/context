---
site: courts.example
search: courts, tennis, riverside courts, court booking
---

# courts.example

An invented city tennis court booking site, for the hand-back bench
(`tests/handback.md`). Its times page is behind a bot check nothing gets past
(`captcha: always`): only after the solver, a reload and a fresh browser have
all had a go may Tex hand it to the person, once, and then read the page
itself.

## https://courts.example/
title: Riverside Courts
text: Four hard courts by the river. Book up to a week ahead.
- link: Free times -> https://courts.example/times

## https://courts.example/times
title: Free times | Riverside Courts
captcha: always
text: Saturday, October 17: court 2 at 9 am, court 4 at 4 pm. Every other slot is booked.
