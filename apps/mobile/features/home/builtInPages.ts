/**
 * The homepage's own copy of its pages, drawn when the live site cannot be
 * read: before the Website setting is on for the homepage's workspace, while
 * the network is down, or on a self-hosted deployment with no such workspace.
 * The homepage is never blank because a setting is off.
 *
 * These are the same Markdown files written into that workspace's `website/`
 * folder, frontmatter and all, so the fallback and the live site are one
 * format. Once the site is on, the files there win and can drift from these on
 * purpose: that folder is where the homepage is edited. `homeSite.test.ts`
 * keeps these honest where honesty is checkable (no em dashes, the price the
 * checkout charges, every page parses as a website page).
 */
export const BUILT_IN_PAGES: Readonly<Record<string, string>> = {
  "index": `---
title: Welcome
description: Notes for your team and your AI tools, in plain Markdown files you own.
nav: 0
---

# Notes for your team and your AI tools

Context is a notes app your team writes in, and so do Claude, ChatGPT, Cursor and any other AI tool that speaks MCP. Every note is a plain Markdown file in storage you own.

[<kbd>Create your workspace</kbd>](/login)

You're reading a workspace in Context right now. The pages in the sidebar are notes, and this site is built from them. Open a few, or press <kbd>⌘K</kbd> to search.

## Tell one AI. The others already know.

1. Tell ChatGPT something once. It saves a note to your workspace.
2. Open Claude Code tomorrow. It reads that note and picks up where you left off.
3. A teammate's AI sees it too, if you shared it with the team. Your private notes stay private.

## Yours to keep

- Your notes live in a bucket dedicated to your workspace. The one copy we keep, for Fast Search, is off until you turn it on.
- Every note is a real file in a real folder. Open it in Obsidian or any text editor.
- Leaving is free on every plan. Download everything, or hand over the bucket.
`,
  "how-it-works": `---
title: How it works
nav: 1
---

# How it works

Context is two things: a notes app, and one MCP address that every AI tool you use connects to.

## A workspace

A workspace is a folder of Markdown notes. Yours is private to you. A shared workspace has members, and each member has a role: owner, editor or member.

You can belong to as many workspaces as you like. One connection reaches all of them.

## One address for every AI tool

You add one address to Claude, ChatGPT, Cursor or VS Code, and sign in once. After that, each tool can search your notes, read them and write back.

Every change is recorded in your workspace's history, under the name of the tool that made it. You can revoke any tool's access at any time.

## Writing together

People and AI tools write in the same notes. Two people can type in one note at once, and edits made offline are merged when you're back.

[<kbd>Connect your AI</kbd>](/connect-your-ai)
`,
  "connect-your-ai": `---
title: Connect your AI
nav: 2
---

# Connect your AI

Any AI tool that supports MCP can use your workspace. Setup takes about a minute.

## Claude and ChatGPT

Add Context as a connector, then sign in. The app walks you through it and checks each step as you go.

## Claude Code, Cursor and VS Code

Run one command in a terminal:

\`\`\`
npx @supa-media/context
\`\`\`

It finds the tools you have installed, connects each one, and adds the Context skills so your AI knows when to read and save notes.

## What your AI can do

- Search and read the notes you can see
- Write new notes and improve existing ones
- Catch up on what changed since it last looked
- Save the important parts of a conversation before it ends

[<kbd>Create your workspace</kbd>](/login)
`,
  "your-files": `---
title: Your files
nav: 3
---

# Your files

Context keeps your notes as ordinary files. There is no hidden format to escape from.

## Plain Markdown

A note is a \`.md\` file at a real path, like \`1-projects/launch.md\`. Folders are real folders. Obsidian, a text editor or a sync tool can all open the same files.

## Storage you own

Bring your own bucket on Cloudflare R2, AWS S3 or anything compatible, and Context works inside it. Or let us create one for you. Either way it's one bucket per workspace, never a folder in a shared one.

## Leaving is free

Download everything, or hand the bucket to storage of your own. It works the same on both plans, and it still works after you cancel. Cancelling makes a workspace read-only. It never deletes anything.

Search indexes are copies we can rebuild from your files. They are never the only copy of anything.
`,
  "who-sees-what": `---
title: Who sees what
nav: 4
---

# Who sees what

Every note is either private or team.

- **Private** means only the workspace's owners, and the AI tools they connected.
- **Team** means the people you added to the workspace, and their AI tools.

There is no third setting that makes a note public. To show a note to someone outside the team, you make a link, and you can turn that link off at any time.

## Folders set the default

Each folder has a default, and a single note can differ from its folder. The rules live in one file, \`privacy.md\`, which Context writes for you.

## An AI sees what its person sees

An AI tool can read exactly what the person who connected it can read, and nothing more. Your private notes never reach a teammate's AI.
`,
  "pricing": `---
title: Pricing
nav: 5
---

# Pricing

Free on your own storage. $5 a month per workspace on ours.

## Free

Connect your own bucket on R2, S3 or anything compatible. You pay your storage provider, and you pay us nothing.

- Every feature, every AI tool
- An email address that saves messages into your inbox folder
- Self-host the whole thing if you like

## Managed, $5 a month per workspace

We create the bucket and pay for it. Early tester price, held for as long as you keep it.

- Everything in Free
- Up to 50 GB of storage, with nothing to set up
- Fast Search, which keeps a rebuildable copy of your text in a database we run

[<kbd>Create your workspace</kbd>](/login)
`,
  "open-source": `---
title: Open source
nav: 6
---

# Open source

Context is MIT licensed. The app, the gateway and the plugins are all on GitHub.

You can run the whole thing yourself, pointed at your own bucket, without us.

[<kbd>View on GitHub</kbd>](https://github.com/Supa-Media/context)
`,
};
