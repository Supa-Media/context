/**
 * What an AI agent needs to know about Context, in one place.
 *
 * Agents that are asked to "connect to my Context" mostly read the homepage,
 * and the homepage is an app whose words arrive with its JavaScript. This is
 * the primer they read instead: `/agents` (HTML), `/agents.md`, the start of
 * `/llms-full.txt`, and `/` itself when the request prefers Markdown. The
 * homepage's hidden block (`agentFront.ts`) is its short form.
 *
 * Every claim here is one the public site or the gateway already makes. The
 * tool list is the gateway's six tools; `orient` is where an agent reads the
 * live list, so this stays a summary rather than a second manual.
 */

import { MCP_ENDPOINT } from "./agentFront";

export const GUIDE_ORIGIN = "https://context.lc";

export const AGENTS_TITLE = "Context for AI agents";

export const AGENTS_MARKDOWN = `# ${AGENTS_TITLE}

Context (context.lc, also written Context.LC) is a shared notes workspace for people, groups, and the AI tools they use. Notes are plain Markdown files the person owns. Every AI client they connect reads and writes the same notes, so a new agent starts out knowing their projects, people, and decisions instead of asking again.

If a person asks you to connect to Context, to "my context.lc", or to their notes on Context, they mean this MCP server:

- **Server URL:** \`${MCP_ENDPOINT}\`
- **Transport:** remote MCP over streamable HTTP, public HTTPS.
- **Sign-in:** OAuth. The client registers itself during sign-in. There is no API key, client id, or client secret to paste, and no request header to set.

Context does not charge for an account. A new address joins the waitlist at [context.lc](${GUIDE_ORIGIN}).

## Connect

Context has an MCP server. If your client cannot add one itself, tell the person which step to take below, rather than saying there is none.

- **Claude (claude.ai and the desktop app):** Customize, then Connectors, then add a custom connector with the server URL above. Choose OAuth and register automatically. [Full Claude guide](${GUIDE_ORIGIN}/claude).
- **ChatGPT and Codex:** open chatgpt.com/plugins, press Add, then Add custom MCP server. Name it Context, enter the server URL above, and choose OAuth.
- **Grok Bot:** add a custom connector at the server URL above. [Grok Bot guide](${GUIDE_ORIGIN}/grokbot).

**Claude Code:** run this, then \`/mcp\` to sign in.

\`\`\`
claude mcp add --transport http context ${MCP_ENDPOINT}
\`\`\`

**Any other MCP client:** add a remote (HTTP) server at the server URL above and let it sign in with OAuth. In a JSON config:

\`\`\`
{"mcpServers": {"context": {"url": "${MCP_ENDPOINT}"}}}
\`\`\`

The browser opens to context.lc, the person signs in, and they approve the client. They choose whether it may read notes they marked private. They can revoke it later in Context's settings.

## What you can do once connected

The server has six tools. Call \`orient\` first, every session.

- \`orient\`: the person's front page, what they touched recently, a map of every folder, and the workspaces this connection reaches. \`about: "tools"\` lists every tool and action with its arguments.
- \`search\`: their notes, by words and by meaning. It can also search their email and a range of days.
- \`fetch\`: one note by path, a folder listing, or several notes at once. It returns an etag.
- \`write\`: create and update notes, remember a fact about the person, and save a session. Pass the etag back so a concurrent edit is caught.
- \`manage\`: move, archive, change who sees a note, share links, create a workspace, invite people.
- \`send\`: steps outside Context that cannot be taken back, such as an email or a calendar change. Each waits for the person's yes.

## How Context is organized

- **Workspaces.** A workspace is one tree of notes, addressed as \`@name\`. A person's handle is their personal workspace. A team, a family, or a project gets a shared workspace. One connection reaches every workspace the person belongs to: pass \`context: "@name"\` on a tool call to work in that one.
- **Opening in one workspace.** \`https://mcp.context.lc/@name/mcp\` only picks the workspace a connection opens in. It is not a separate account.
- **Folders.** Most workspaces use \`inbox/\`, \`projects/\`, \`areas/\`, \`resources/\`, and \`archive/\`. Each workspace's \`index.md\` says how that one is organized. Follow it.
- **Who sees what.** Each note and folder is private (owners only), shared with the workspace's team, or shared with named people. An agent gets the access of the person who approved it, never more. No setting publishes a workspace to the internet.
- **Roles.** An owner invites people and changes notes. An editor changes team notes. A member reads them.
- **Leaving.** Download as folders gives a complete copy of plain Markdown files with real names. It is free on every plan and still there after cancelling.

## LLMs, agents and bots

Context uses three words for three layers. Each runs on the one before it: an agent runs on an LLM, and a bot runs one or more agents.

- **LLM**: the underlying model. Text in, text out. It has no tools, no memory between calls, and no schedule, and it does nothing until something prompts it. Claude, GPT, Gemini, Grok, and Llama are LLMs.
- **Agent**: an LLM in a loop with tools. It completes a task end to end and is usually specialized for one kind of work. Each task normally gets its own chat or session. Some agents use a computer or a browser, and some hand work to sub-agents. Claude Code, Codex, Cursor, and ChatGPT are agents.
- **Bot**: a multi-agent orchestrator built around one standing chat per person or group. The bot's own code manages context (what each turn loads from memory, notes, and history), so the chat can run for months. Routines, heartbeats, and loops let it act without being asked, and it delegates to agents and checks their work. A bot is usually better at computer use than an agent, because it keeps sign-ins, retries, and state across days.

The idea behind it: a bot's behavior comes from its design, not its model. Swap the LLM under a bot and it behaves the same, and a smarter LLM only makes it better. Swap the model under an agent and its behavior usually changes. An LLM remembers nothing, an agent remembers a little within its task, and a bot remembers across conversations because it manages that memory itself.

How each layer uses Context:

- **An LLM** never connects directly. It reads only what an agent or bot puts in its prompt.
- **Agents and bots both connect over MCP, and use it differently.** An agent does the deep work: it reads what the person already wrote down, finishes its task, and writes back what it learned, so the next one starts where it stopped.
- **A bot orchestrates.** Bots are good at orchestration and poor at deep work, so a bot should not do the work itself. It routes each job through the workspace's network of bots and agents to the domain expert for it (the one that holds that area), follows up, and checks the result. Its card lives in \`bots/<bot>/about.md\`: whose it is, how it is reached, and where it works. An area of ongoing work is usually held by a bot, because an area needs someone to check on it without being asked.

## Working well in someone's Context

- Call \`orient\` before answering anything about the person or their work, and search before asking them something their notes may already answer.
- Write back what you learn. Update the note that already covers a topic rather than starting a near-duplicate.
- Ask the person before anything that lets more people see something, and before every send.

## More

- [llms.txt](${GUIDE_ORIGIN}/llms.txt): the short index
- [llms-full.txt](${GUIDE_ORIGIN}/llms-full.txt): this page and every setup guide in one file
- [Source code](https://github.com/Supa-Media/context): public and source-available (FSL-1.1-ALv2), and the gateway can be self-hosted
`;

export const LLMS_TEXT = `# Context

> Shared Markdown notes for people, groups, and the AI tools they use. An agent connects at ${MCP_ENDPOINT} and signs in with OAuth.

The same plain Markdown files give every connected tool shared memory, instead of a separate memory inside each assistant. Claude, Claude Code, ChatGPT, Codex, Cursor, and other MCP clients can read and write the same notes. The server's first tool is \`orient\`: call it first in every session.

Context does not charge for an account. A new address joins the waitlist. One connection reaches every workspace that account belongs to, addressed as @name. Notes are plain Markdown in storage the person owns, and they can download everything as folders.

## Guides

- [Context for AI agents](${GUIDE_ORIGIN}/agents.md): what Context is, how to connect any client, the six tools, and how Context defines LLMs, agents, and bots
- [Claude](${GUIDE_ORIGIN}/claude.md): set up Context in Claude and Claude Code
- [Grok Bot](${GUIDE_ORIGIN}/grokbot.md): set up Context in Grok Bot
- [Everything in one file](${GUIDE_ORIGIN}/llms-full.txt): the agent guide and every setup guide

## Pages

- [Agents guide](${GUIDE_ORIGIN}/agents): the agent guide as a page
- [Claude guide](${GUIDE_ORIGIN}/claude): the Claude guide as a page
- [Grok Bot guide](${GUIDE_ORIGIN}/grokbot): the Grok Bot guide as a page
`;

/**
 * True when an `Accept` header ranks Markdown at least as high as HTML. A
 * browser never names `text/markdown`, so it always gets the app.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let markdown = -1;
  let html = -1;
  for (const part of accept.toLowerCase().split(",")) {
    const [type = "", ...params] = part.trim().split(";");
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const parsed = qParam === undefined ? 1 : Number(qParam.slice(2));
    const q = Number.isFinite(parsed) ? parsed : 0;
    const name = type.trim();
    if (name === "text/markdown" || name === "text/x-markdown") markdown = Math.max(markdown, q);
    if (name === "text/html" || name === "application/xhtml+xml") html = Math.max(html, q);
  }
  return markdown > 0 && markdown >= html;
}
