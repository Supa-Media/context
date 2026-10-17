---
site: claude.ai
sign_in: https://claude.ai/login
search: claude, anthropic
---

# claude.ai

Scripted after the app's setup guide for Claude (`guides.ts`): add a custom
connector with Context's address, press Connect to sign in, then set both
tool groups to Always allow so Claude stops asking before each note.

## https://claude.ai/login
title: Sign in | Claude
text: Sign in or create an account. Enter your email and we'll send you a code.
- textbox: Email
- button: Continue with email

## https://claude.ai/new
title: Claude
signed in only
text: How can I help you today?
- link: Settings -> https://claude.ai/settings/account
- link: Connectors -> https://claude.ai/customize/connectors

## https://claude.ai/customize/connectors
title: Connectors | Claude
signed in only
text: Connectors let Claude use your tools and data.
text (!added claude): Context is not added yet.
text (added claude, !connected claude): Context: added, not connected. Press Connect to sign in to it.
text (connected claude): Context: connected. Choose when Claude may use its tools.
- button: Add custom connector -> https://claude.ai/customize/connectors?modal=add-custom-connector
- button (added claude, !connected claude): Connect -> https://context.lc/authorize?client=claude
- select (connected claude): Read-only tools (Needs approval, Always allow)
- select (connected claude): Write/delete tools (Needs approval, Always allow)

## https://claude.ai/customize/connectors?modal=add-custom-connector
title: Add custom connector | Claude
signed in only
text: Add a custom connector. Give it a name and the address of a remote MCP server.
- textbox: Name
- textbox: Remote MCP server URL
- button: Add -> https://claude.ai/customize/connectors [needs Name, Remote MCP server URL = https://mcp.context.lc/mcp] [sets added claude]
- button: Cancel -> https://claude.ai/customize/connectors
