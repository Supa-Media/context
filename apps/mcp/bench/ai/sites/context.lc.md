---
site: context.lc
sign_in: https://context.lc/login
search: context
---

# context.lc

Context's own sign-in and the consent screen an AI app's OAuth lands on.
Signing in takes an emailed code, so the person does it, through a handoff.

## https://context.lc/
title: Context
text: One memory for every AI you use.
- link: Sign in -> https://context.lc/login

## https://context.lc/login
title: Sign in | Context
text: Sign in to Context. Enter your email and we'll send you a 6-digit code.
- textbox: Email
- button: Email me a code

## https://context.lc/authorize?client=chatgpt
title: Allow ChatGPT | Context
signed in only
text: ChatGPT wants to read and add notes in your context. Signed in as @maya.
- button: Approve -> https://chatgpt.com/plugins [sets connected chatgpt]
- button: Deny -> https://chatgpt.com/plugins

## https://context.lc/authorize?client=claude
title: Allow Claude | Context
signed in only
text: Claude wants to read and add notes in your context. Signed in as @maya.
- button: Approve -> https://claude.ai/customize/connectors [sets connected claude]
- button: Deny -> https://claude.ai/customize/connectors
