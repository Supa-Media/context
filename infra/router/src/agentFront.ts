/**
 * The words an agent can read on the homepage without running the app.
 *
 * `/` is the Expo shell. Its first paint is JavaScript. This block is inserted
 * into that document, ahead of `#root`, so the HTML itself says what Context
 * is and where an agent connects. It is clipped out of the layout: the notes
 * page draws the same facts once it loads, and a second visible copy would
 * push the sign-up off the first screen.
 */

export const MCP_ENDPOINT = "https://mcp.context.lc/mcp";

/** The notes page's own headline (`NotesPage.web`). Kept identical on purpose. */
export const LANDING_H1 = "Context gives your brain that feeling you have when your room is clean.";

export const AGENT_SENTENCE =
  "Context is shared Markdown notes for a person and the AI tools they use. " +
  `An agent connects at ${MCP_ENDPOINT} and signs in with OAuth.`;

const BLOCK = `<div id="context-for-agents" aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
<nav aria-label="Context">
<a href="/">Context</a>
<a href="/agents">Grok Bot guide</a>
<a href="/claude">Claude guide</a>
<a href="/llms.txt">llms.txt</a>
</nav>
<main>
<h1>${LANDING_H1}</h1>
<p>It is an opinionated way to put everything away in plain notes that you can always edit and export, and so can the AI tools you connect.</p>
<p>${AGENT_SENTENCE} <a href="/agents">Grok Bot guide</a>. <a href="/claude">Claude guide</a>. <a href="/llms.txt">llms.txt</a>.</p>
</main>
</div>`;

/** The homepage HTML with the block as the first thing in `<body>`, or unchanged. */
export function injectAgentFront(html: string): string {
  if (html.includes('id="context-for-agents"')) return html;
  const at = html.search(/<body[^>]*>/i);
  if (at === -1) return html;
  const open = /<body[^>]*>/i.exec(html.slice(at));
  if (open === null) return html;
  const insert = at + open[0].length;
  return `${html.slice(0, insert)}${BLOCK}${html.slice(insert)}`;
}
