/**
 * The words an agent can read on the homepage without running the app.
 *
 * `/` is the Expo shell. Its first paint is JavaScript. This block is inserted
 * into that document, ahead of `#root`, so the HTML itself says what Context
 * is, where an agent connects and how. The homepage's site rides at the end of
 * `<body>` (`homeSite.ts`), so this block comes before every large thing in
 * the document: a reader that keeps only the first part still has it. It is clipped out of the layout: the notes
 * page draws the same facts once it loads, and a second visible copy would
 * push the sign-up off the first screen.
 */

export const MCP_ENDPOINT = "https://mcp.context.lc/mcp";

/** The notes page's own headline (`NotesPage.web`). Kept identical on purpose. */
export const LANDING_H1 = "Context gives your brain that feeling you have when your room is clean.";

export const AGENT_SENTENCE =
  "Context is shared Markdown notes for a person and the AI tools they use. " +
  `An agent connects at ${MCP_ENDPOINT} and signs in with OAuth.`;

/**
 * Clipped, not `aria-hidden`: some readers drop what is hidden from assistive
 * technology, and this is the part of the page that names the server. A
 * screen reader hears a short "for AI agents" section first, which is true.
 */
const BLOCK = `<div id="context-for-agents" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
<nav aria-label="Context">
<a href="/">Context</a>
<a href="/agents">Agents guide</a>
<a href="/claude">Claude guide</a>
<a href="/llms.txt">llms.txt</a>
</nav>
<main>
<h1>${LANDING_H1}</h1>
<p>It is an opinionated way to put everything away in plain notes that you can always edit and export, and so can the AI tools you connect.</p>
<h2>For AI agents</h2>
<p>Context (context.lc) is a shared notes workspace for people, groups, and the AI tools they use. Notes are plain Markdown files the person owns, and every AI client they connect reads and writes the same notes. If a person asks you to connect to Context or to their context.lc, they mean its MCP server: <code>${MCP_ENDPOINT}</code>, remote MCP over streamable HTTP. There is no API key, client id, or client secret to paste.</p>
<ul>
<li>Claude: Customize, then Connectors, then add a custom connector with that URL.</li>
<li>Claude Code: <code>claude mcp add --transport http context ${MCP_ENDPOINT}</code>, then <code>/mcp</code>.</li>
<li>ChatGPT and Codex: chatgpt.com/plugins, Add, then Add custom MCP server with that URL.</li>
<li>Any other MCP client: add a remote HTTP server at that URL.</li>
</ul>
<p>Once connected, call <code>orient</code> first. The six tools are orient, search, fetch, write, manage, and send. The whole guide is at <a href="/agents">context.lc/agents</a>, as Markdown at <a href="/agents.md">/agents.md</a>, and with every setup guide at <a href="/llms-full.txt">/llms-full.txt</a>.</p>
</main>
<footer>
<p>An agent connects at <a href="${MCP_ENDPOINT}">mcp.context.lc/mcp</a> and signs in with OAuth. <a href="/agents">Agents guide</a>. <a href="/claude">Claude guide</a>. <a href="/llms.txt">llms.txt</a>.</p>
</footer>
</div>`;

/** Ahead of everything else in `<head>`, so a reader that stops early still finds the guide. */
const ALTERNATE = `<link rel="alternate" type="text/markdown" href="/agents.md" title="${"Context for AI agents"}">`;

/** The homepage HTML with the block as the first thing in `<body>`, or unchanged. */
export function injectAgentFront(html: string): string {
  if (html.includes('id="context-for-agents"')) return html;
  html = withAlternate(html);
  const at = html.search(/<body[^>]*>/i);
  if (at === -1) return html;
  const open = /<body[^>]*>/i.exec(html.slice(at));
  if (open === null) return html;
  const insert = at + open[0].length;
  return `${html.slice(0, insert)}${BLOCK}${html.slice(insert)}`;
}

function withAlternate(html: string): string {
  const open = /<head[^>]*>/i.exec(html);
  if (open === null) return html;
  const at = open.index + open[0].length;
  return `${html.slice(0, at)}${ALTERNATE}${html.slice(at)}`;
}
