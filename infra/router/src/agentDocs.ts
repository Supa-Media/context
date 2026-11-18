/**
 * Public agent docs, served by the router (no auth, no Expo shell).
 *
 * `/grokbot.md` and `/claude.md` are the sources. `/agents` and `/claude` are
 * those files rendered as HTML, so the page and the markdown cannot drift.
 * `/llms.txt` is the index. Tex hosts do not serve these: tex.lc is a
 * different front door.
 */

import { MCP_ENDPOINT } from "./agentFront";

export const GUIDE_ORIGIN = "https://context.lc";

export type AgentDocName = "llms" | "grok-md" | "claude-md" | "agents" | "claude";

const PATHS: ReadonlyMap<string, AgentDocName> = new Map([
  ["/llms.txt", "llms"],
  ["/grokbot.md", "grok-md"],
  ["/claude.md", "claude-md"],
  ["/agents", "agents"],
  ["/claude", "claude"],
]);

/** The doc a path asks for, or null. Trailing slash folds. Query is ignored. */
export function agentDocFor(pathname: string): AgentDocName | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PATHS.get(path) ?? null;
}

const GROK_TITLE = "Set up Context in Grok Bot";
const CLAUDE_TITLE = "Set up Context in Claude";

/**
 * Grok Bot. The connector steps are Grok Bot's own account controls: one
 * connector, more than one signed-in account, each with a label. The token
 * and sign-out lines are what Context does on that second approval.
 */
export const GROK_MARKDOWN = `# ${GROK_TITLE}

Context is shared Markdown notes. One account can hold several workspaces. An agent connects over MCP and signs in with OAuth. There is no API key to paste.

## 1. Connect

1. In Grok Bot, add a custom connector (a custom MCP server).
2. Name it Context. Choose a remote HTTPS server, not a command that runs on the computer.
3. Server URL: \`${MCP_ENDPOINT}\`
4. Leave the client id, client secret, and headers empty. Context registers the client during sign-in.
5. Add it. When the browser opens, sign in to Context and approve.

The server is MCP over streamable HTTP. A call sends \`Authorization: Bearer\` and the access token. Paste the URL above. Do not invent a different path.

## 2. Workspaces

A workspace is one tree of notes, addressed as \`@name\`.

- The name is 2 to 32 characters: lowercase letters, digits, and hyphens. It cannot start or end with a hyphen. Claiming it is permanent.
- After you can sign in, you claim a handle. That handle is your personal workspace. It stays yours.
- Keep separate areas in separate workspaces: the personal one, one shared workspace per project, a business, a family.
- You can own at most 10. A workspace someone invited you into does not count.
- Create a shared one while signed in, at [context.lc/workspace/new](${GUIDE_ORIGIN}/workspace/new). Or ask the connected agent to create it. Check the handle is free before claiming it.
- One connection reaches every workspace you belong to. Say \`context: "@name"\` when the agent should work in that one.
- \`https://mcp.context.lc/@name/mcp\` only chooses which workspace that connection opens in. It is not another account, and it does not hide the others.

## 3. Share with someone you trust

Context does not charge for an account. Sign-up is not open to every address.

1. Each person joins the waitlist at [context.lc](${GUIDE_ORIGIN}) with an email or a phone number.
2. A sign-in code is sent once that address is admitted. An invitation to a workspace also lets that address create an account.
3. Make a shared workspace for the notes you both should see. The personal workspace stays with its owner.
4. The owner invites the other person by email or \`@handle\`, as an editor or a member. Only an owner can invite. An owner cannot be created by an invitation.

Roles:

- **Owner.** Invites people, changes notes, and can let an AI read notes marked private.
- **Editor.** Changes team notes. Cannot invite. Cannot see private notes.
- **Member.** Reads team notes. Cannot change them.

Private notes stay with the owners. Team notes are what members can open. No setting publishes a workspace to the internet.

## 4. Two people on one Grok Bot

Each person still needs their own Context account. Grok Bot holds more than one account on the same connector, and each account has a label. The connector can add, rename, and remove those accounts.

1. Add the Context connector once, at \`${MCP_ENDPOINT}\`.
2. Person A signs in.
3. Person A signs out of context.lc in the browser. The approval page is whoever is signed in there. Sign out from the account menu, or the second approval is still person A.
4. Add a second account on the same connector, and person B signs in.
5. Label each account with the person's name.
6. Tell the bot which label to use for whom.

A second sign-in mints a new access token and a new refresh token. The two grants do not replace each other. Calls are authorized by that bearer token. The MCP server does not use a cookie to decide who is calling.

One URL is enough. A different URL does not create a separate account. \`https://mcp.context.lc/@name/mcp\` only chooses which workspace that connection opens in.

## 5. Separate workspaces for separate projects

Use one shared workspace per project. Invite only the people who should see it. The same connector can open any workspace that account belongs to. You do not add the server again for each project.
`;

/**
 * Claude and Claude Code. Connector clicks follow Anthropic's custom-connector
 * help (Free through Enterprise; Free is one connector). Claude Code's command
 * and scopes follow Claude Code's MCP docs: HTTP transport, OAuth per URL.
 */
export const CLAUDE_MARKDOWN = `# ${CLAUDE_TITLE}

The MCP address is \`${MCP_ENDPOINT}\`. The transport is streamable HTTP. Sign-in is OAuth. Do not paste an API key, a client id, or a client secret.

## 1. claude.ai

Custom connectors are on Free, Pro, Max, Ultra, Team, and Enterprise. Free can add one. Claude calls the server from Anthropic's network, so the address has to be public HTTPS on port 443.

On an individual plan, open [Customize, then Connectors](https://claude.ai/customize/connectors). On Pro and Max the help article's path is **+ Add**, then **Add custom connector**. Free and Ultra are on that plans list. The article spells those clicks out for Pro and Max.

1. Name it Context.
2. Server URL: \`${MCP_ENDPOINT}\`
3. Choose sign-in (now, or when needed). Do not choose "No sign in".
4. OAuth client: **Register automatically**. Context refuses a client id it has not registered, and it has none to paste.
5. Leave request headers empty. A fixed bearer token is not how this server signs in.
6. Add it, then sign in to Context and approve. You choose whether it can see notes marked private.

On Team and Enterprise, an Owner or Primary Owner adds it first: Organization settings, then Connectors, Add, Custom, Web, with the same URL and Register automatically. Each member then opens Customize, then Connectors, and presses Connect, signing in with their own Context account. A shared API key is the wrong choice here. Context does not have one.

Turn the connector on for a chat from the + menu, then Connectors.

The clicks are [Anthropic's custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## 2. Claude Code

In a terminal:

\`\`\`
claude mcp add --transport http context ${MCP_ENDPOINT}
\`\`\`

Then, in Claude Code, run \`/mcp\` and sign in. You can also run \`claude mcp login context\`. The browser opens, you approve, and Claude Code stores the token. Do not pass \`--header\`. A bearer header skips OAuth.

Where the command saves it:

- \`--scope local\` is the default. This project, this user, in \`~/.claude.json\`.
- \`--scope user\` uses it in every project on this computer, still only for this user.
- \`--scope project\` writes \`.mcp.json\` in the repo. That shares the server address with the team. It does not share the sign-in. Each person runs \`/mcp\` and signs in as themselves.

Adding the same name again at the same scope is refused. Claude Code stores the OAuth sign-in per server URL.

Docs: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

## 3. Workspaces

A workspace is one tree of notes, addressed as \`@name\` (2 to 32 lowercase letters, digits, and hyphens, permanent once claimed).

- Your handle is your personal workspace. It stays yours.
- Use a separate shared workspace per project, business, or family. You can own at most 10.
- Create one while signed in at [context.lc/workspace/new](${GUIDE_ORIGIN}/workspace/new), or ask Claude to create it.
- One connection reaches every workspace you belong to. Say \`context: "@name"\` to work in that one.
- A URL with \`@name\` in it only picks the workspace the connection opens in. It is not a second account.

## 4. Share with someone you trust

Context does not charge. A new address joins the waitlist at [context.lc](${GUIDE_ORIGIN}). A sign-in code is sent after the address is admitted. An invitation also lets that address create an account.

The owner of a shared workspace invites the other person by email or \`@handle\`, as an editor or a member.

- **Owner.** Invites, changes notes, and can let an AI read notes marked private.
- **Editor.** Changes team notes. Cannot invite or see private notes.
- **Member.** Reads team notes. Cannot change them.

Invite people into a shared workspace. The personal one stays with its owner.

## 5. Separate projects

One shared workspace per project. Invite only the people who should see it. Do not add the MCP server again for each project.

## 6. People sharing one Claude account

claude.ai keeps one connection for the person who is signed in. It does not give that login a second Context account, with its own label, on the same connector. On Team and Enterprise, each member connects the connector the owner added and signs in with their own Context account. Two people who share one Claude login share that one Context sign-in.

Claude Code stores the sign-in per URL, not per name. Adding \`${MCP_ENDPOINT}\` twice under two names does not create two Context accounts. A scope (\`local\`, \`user\`, or \`project\`) chooses where the server config is stored. It does not choose a second Context account.

Use a separate Claude account, or a separate computer user with their own \`~/.claude.json\` and their own \`/mcp\` sign-in. To share notes on purpose, invite both people into one Context workspace and let each connect as themselves.

On Context's side, each approval is still its own token. A second sign-in does not erase the first. The approval page is whoever is signed in at context.lc, so sign out before the other person approves.
`;

export const LLMS_TEXT = `# Context

> Shared Markdown notes for a person and the AI tools they use. An agent connects at ${MCP_ENDPOINT} and signs in with OAuth.

Context does not charge for an account. A new address joins the waitlist. One connection reaches every workspace that account belongs to, addressed as @name.

## Guides

- [Grok Bot](${GUIDE_ORIGIN}/grokbot.md): set up Context in Grok Bot
- [Claude](${GUIDE_ORIGIN}/claude.md): set up Context in Claude and Claude Code

## Pages

- [Grok Bot guide](${GUIDE_ORIGIN}/agents): the same Grok Bot guide as a page
- [Claude guide](${GUIDE_ORIGIN}/claude): the same Claude guide as a page
- [Privacy](${GUIDE_ORIGIN}/privacy): what Context stores
- [Terms](${GUIDE_ORIGIN}/terms): the terms of use
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline marks used in these guides: code, bold, and links. Anything else is text. */
function inline(source: string): string {
  const parts: string[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    parts.push(escapeHtml(source.slice(cursor, start)));
    if (match[1] !== undefined) parts.push(`<code>${escapeHtml(match[1])}</code>`);
    else if (match[2] !== undefined) parts.push(`<strong>${escapeHtml(match[2])}</strong>`);
    else parts.push(link(match[3] ?? "", match[4] ?? ""));
    cursor = start + match[0].length;
  }
  parts.push(escapeHtml(source.slice(cursor)));
  return parts.join("");
}

function link(label: string, href: string): string {
  const safe = /^(https:\/\/|\/)/.test(href) ? href : "";
  if (safe === "") return escapeHtml(label);
  return `<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`;
}

/**
 * The guide as HTML. The markdown is the only prose. This adds the document
 * around it and a link to the markdown file.
 */
export function renderGuideHtml(markdown: string, page: { path: string; markdownPath: string }): string {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? "Context";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="canonical" href="${GUIDE_ORIGIN}${page.path}">
<style>
body{margin:0 auto;max-width:42rem;padding:32px 20px 64px;font:18px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1A1714;background:#FFFDF9}
h1{font-size:2rem;line-height:1.15;font-weight:500}
h2{font-size:1.25rem;margin-top:1.6em}
a{color:#2A45CF}
code,pre{font-family:ui-monospace,monospace;font-size:.9em}
pre{padding:12px 14px;background:#F4F0EA;overflow:auto}
p,li{margin:.4em 0}
</style>
</head>
<body>
<p><a href="${page.markdownPath}">Markdown</a></p>
<main>
${markdownToHtml(markdown)}
</main>
</body>
</html>
`;
}

/** A small subset: the headings, lists, fences, and paragraphs these guides use. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").slice(2))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").replace(/^\d+\. /, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,3}\s|```|- |\d+\. )/.test(lines[i] ?? "")
    ) {
      buf.push(lines[i] ?? "");
      i += 1;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function textResponse(body: string, type: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The bytes for one doc. GET and HEAD only. */
export function agentDocResponse(doc: AgentDocName, method: string): Response {
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const full =
    doc === "llms"
      ? textResponse(LLMS_TEXT, "text/plain; charset=utf-8")
      : doc === "grok-md"
        ? textResponse(GROK_MARKDOWN, "text/markdown; charset=utf-8")
        : doc === "claude-md"
          ? textResponse(CLAUDE_MARKDOWN, "text/markdown; charset=utf-8")
          : doc === "agents"
            ? htmlResponse(renderGuideHtml(GROK_MARKDOWN, { path: "/agents", markdownPath: "/grokbot.md" }))
            : htmlResponse(renderGuideHtml(CLAUDE_MARKDOWN, { path: "/claude", markdownPath: "/claude.md" }));
  if (method === "HEAD") return new Response(null, { status: 200, headers: full.headers });
  return full;
}
