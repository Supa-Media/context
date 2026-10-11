---
site: chatgpt.com
sign_in: https://chatgpt.com/auth/login
search: chatgpt, openai, gpt
---

# chatgpt.com

Scripted after ChatGPT's own screens as the app's setup guide describes them
(`apps/mobile/features/agentSetup/guides.ts`, 2026-10-07): custom MCP servers
are added under Plugins, with OAuth, and ChatGPT then opens Context's sign-in.

## https://chatgpt.com/
title: ChatGPT
text: What can I help with?
- link: Log in -> https://chatgpt.com/auth/login
- link: Plugins -> https://chatgpt.com/plugins

## https://chatgpt.com/auth/login
title: Log in or sign up | ChatGPT
text: Welcome back. Enter your email address to log in.
- textbox: Email address
- button: Continue -> https://chatgpt.com/auth/password [needs Email address]

## https://chatgpt.com/auth/password
title: Enter your password | ChatGPT
text: Enter your password to continue. We also sent a code to your email.
- password: Password
- button: Continue

## https://chatgpt.com/plugins
title: Plugins | ChatGPT
signed in only
text: Plugins let ChatGPT use apps and tools. Personal plugins you've added appear here.
text: Personal: nothing added yet.
text (connected chatgpt): Personal: Context, connected. ChatGPT can search, read and save notes in Context.
- button: Add -> https://chatgpt.com/plugins/new
- link: Settings -> https://chatgpt.com/#settings

## https://chatgpt.com/plugins/new
title: Add custom MCP server | ChatGPT
signed in only
text: Add custom MCP server. Connect a remote MCP server so ChatGPT can use its tools. Custom MCP servers need ChatGPT Plus, Pro, Business, Enterprise or Edu.
- textbox: Name
- textbox: MCP server URL
- select: Authentication (No authentication, OAuth)
- checkbox: I understand and want to continue
- button: Create -> https://context.lc/authorize?client=chatgpt [needs Name, MCP server URL = https://mcp.context.lc/mcp, Authentication = OAuth, I understand and want to continue]
- button: Cancel -> https://chatgpt.com/plugins
