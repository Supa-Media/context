---
site: gathering.example
search: gathering, fall gathering
---

# gathering.example

An invented conference's registration form behind a hidden captcha, for hand-back bench case 16. From the owner's evening chat of 2026-10-27: on a real registration form, Tex filled every box and pressed Register twice, and the site's invisible captcha turned both presses away without a word. Here Register does nothing, in any browser, until the person has passed the captcha through a handoff; then Tex's next press goes through.

## https://gathering.example/register
title: Register | Fall Gathering 2026
invisible captcha
text: Register for Fall Gathering 2026, Saturday October 31 in Washington, DC. Free; every question is required.
- textbox: Full name
- textbox: Email
- select: Is this your first Fall Gathering? (Choose one, Yes, No)
- select: Do you need transportation? (Choose one, Yes, No)
- button: Register -> https://gathering.example/registered [needs Full name, Email, Is this your first Fall Gathering? = No, Do you need transportation? = No] [sets registered]

## https://gathering.example/registered
title: You're registered | Fall Gathering 2026
text: You're registered for Fall Gathering 2026. A confirmation is on its way to your email.
