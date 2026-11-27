/**
 * The apex's public, indexable pages that are not the app: `/sitemap.xml`,
 * the `/shared-ai-memory` page, and the 404 a crawler gets for an address
 * that is neither a page nor an app screen.
 *
 * Served the same to a person and a crawler, from constants, with no
 * upstream. Tex hosts do not serve these: tex.lc is a different front door.
 *
 * Every claim on the page below is one the guides (`agentDocs.ts`) or the
 * product already make: the endpoint, OAuth sign-in, plain Markdown in
 * storage you own, download as folders, no charge for an account, the
 * waitlist. Do not add a price, a limit, a directory listing or a feature
 * that has not shipped.
 */

import { CLAUDE_CODE_ADD, MCP_ENDPOINT } from "./agentFront";
import { markdownToHtml } from "./agentDocs";
import { escapeHtml } from "./preview/meta";
import { faqJsonLd, FREE_ACCOUNT_SENTENCE, type FaqEntry } from "./faq";

export const ORIGIN = "https://context.lc";

export type PublicPageName = "sitemap" | "shared-ai-memory";

export const SITEMAP_PATH = "/sitemap.xml";
export const SHARED_MEMORY_PATH = "/shared-ai-memory";

/**
 * Every address in the sitemap: indexable, self-canonical, and served by
 * this Worker without sign-in. A path belongs here only if a crawler that
 * fetches it gets a 200 page that is not `noindex`.
 */
export const SITEMAP_PATHS: readonly string[] = [
  "/",
  "/claude",
  "/claude.md",
  "/agents",
  "/grokbot.md",
  "/llms.txt",
  SHARED_MEMORY_PATH,
];

/** The page a path asks for, or null. Trailing slash folds; query is ignored. */
export function publicPageFor(pathname: string): PublicPageName | null {
  if (pathname === SITEMAP_PATH) return "sitemap";
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return path === SHARED_MEMORY_PATH ? "shared-ai-memory" : null;
}

export const SITEMAP_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  SITEMAP_PATHS.map((path) => `  <url><loc>${ORIGIN}${path}</loc></url>\n`).join("") +
  `</urlset>\n`;

export const SHARED_MEMORY_TITLE =
  "Shared AI memory across ChatGPT, Claude, and Cursor, backed by notes you own | Context.LC";
export const SHARED_MEMORY_DESCRIPTION =
  "Share memory between ChatGPT, Claude, Cursor, and other MCP-compatible clients with Context.LC. " +
  "The same plain Markdown notes stay in files you own.";
export const SHARED_MEMORY_H1 = "Shared AI memory, backed by notes you own";

/** The page's questions: shown on the page and, word for word, in its FAQPage data. */
export const SHARED_MEMORY_FAQ: readonly FaqEntry[] = [
  {
    question: "What is shared AI memory?",
    answer:
      "One set of notes that every AI tool you use can read and write, instead of a separate memory inside each assistant. " +
      "With Context, that memory is plain Markdown notes.",
  },
  {
    question: "Can ChatGPT and Claude share the same memory?",
    answer:
      `Yes. Connect both to ${MCP_ENDPOINT} and sign in to the same Context account. ` +
      "Both then read and write the same notes.",
  },
  {
    question: "Is Context an MCP memory server?",
    answer:
      `Yes. Context is a remote MCP server at ${MCP_ENDPOINT}. The transport is streamable HTTP and sign-in is OAuth, ` +
      "so there is no API key to paste.",
  },
  {
    question: "Does it work with Claude Code and Cursor?",
    answer:
      `Any client that can add a remote MCP server can connect. In Claude Code, run ${CLAUDE_CODE_ADD}, then /mcp to sign in. ` +
      "In Cursor, add the same server address.",
  },
  {
    question: "Where are my notes stored?",
    answer: "Notes are plain Markdown files in storage you own. You can download everything as folders.",
  },
  {
    question: "Is Context free?",
    answer: FREE_ACCOUNT_SENTENCE,
  },
];

/** The page's prose, as markdown. The FAQ section is built from SHARED_MEMORY_FAQ. */
export const SHARED_MEMORY_MARKDOWN = `# ${SHARED_MEMORY_H1}

Context.LC is shared Markdown notes for people, groups, and the AI tools they use. ChatGPT, Claude, Cursor, and other MCP-compatible clients read and write the same notes, instead of keeping a separate memory inside each assistant.

## How Context gives AI tools shared memory

The memory is plain Markdown notes. An AI client connects over MCP at \`${MCP_ENDPOINT}\` and signs in with OAuth. There is no API key to paste. What one tool writes, the next one can read.

## Share memory between ChatGPT and Claude

Add \`${MCP_ENDPOINT}\` as a custom connector in each client and sign in to the same Context account. A decision saved from one chat is there in the other. The Claude steps are in [Set up Context in Claude](/claude).

## An MCP memory server in files you own

Context is a remote MCP server. The notes behind it are plain Markdown files in storage you own, not rows in a database only one assistant can read. Each client you connect signs in on its own, and one connection reaches every workspace your account belongs to, addressed as \`@name\`.

## Persistent context across Claude Code and Cursor

A coding session can read the notes a chat wrote, and save what it decided for the next session. In Claude Code:

\`\`\`
${CLAUDE_CODE_ADD}
\`\`\`

Then run \`/mcp\` and sign in. In Cursor, add the same server address as a remote MCP server.

## What stays true

- Notes are plain Markdown in storage you own.
- You can download everything as folders.
- Context does not charge for an account. A new address joins the waitlist.

## Questions

${SHARED_MEMORY_FAQ.map((entry) => `### ${entry.question}\n\n${entry.answer}`).join("\n\n")}
`;

/** JSON for a `<script type="application/ld+json">` block: `<` cannot close it. */
export function jsonLdScript(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

const SHARED_MEMORY_URL = `${ORIGIN}${SHARED_MEMORY_PATH}`;

const SHARED_MEMORY_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${SHARED_MEMORY_URL}#webpage`,
      url: SHARED_MEMORY_URL,
      name: SHARED_MEMORY_TITLE,
      description: SHARED_MEMORY_DESCRIPTION,
      isPartOf: { "@id": `${ORIGIN}/#website` },
    },
    faqJsonLd(SHARED_MEMORY_FAQ, `${SHARED_MEMORY_URL}#faq`),
  ],
};

/** The page: the markdown above in a head of its own, with the FAQ data beside it. */
export function renderSharedMemoryHtml(): string {
  const title = escapeHtml(SHARED_MEMORY_TITLE);
  const description = escapeHtml(SHARED_MEMORY_DESCRIPTION);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${SHARED_MEMORY_URL}">
<link rel="icon" href="${ORIGIN}/favicon.ico" sizes="48x48">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Context.LC">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${SHARED_MEMORY_URL}">
<meta property="og:image" content="${ORIGIN}/og/card.png">
<meta name="twitter:card" content="summary_large_image">
${jsonLdScript(SHARED_MEMORY_JSON_LD)}
<style>
body{margin:0 auto;max-width:42rem;padding:32px 20px 64px;font:18px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1A1714;background:#FFFDF9}
h1{font-size:2rem;line-height:1.15;font-weight:500}
h2{font-size:1.25rem;margin-top:1.6em}
h3{font-size:1.05rem;margin-top:1.2em}
a{color:#2A45CF}
code,pre{font-family:ui-monospace,monospace;font-size:.9em}
pre{padding:12px 14px;background:#F4F0EA;overflow:auto}
p,li{margin:.4em 0}
</style>
</head>
<body>
<nav><a href="/">Context.LC</a> · <a href="/claude">Claude guide</a> · <a href="/agents">Grok Bot guide</a> · <a href="/llms.txt">llms.txt</a></nav>
<main>
${markdownToHtml(SHARED_MEMORY_MARKDOWN)}
</main>
</body>
</html>
`;
}

function cached(body: string | null, type: string, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** The bytes for one page. GET and HEAD only. */
export function publicPageResponse(page: PublicPageName, method: string): Response {
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const [body, type] =
    page === "sitemap"
      ? [SITEMAP_XML, "application/xml; charset=utf-8"]
      : [renderSharedMemoryHtml(), "text/html; charset=utf-8"];
  return cached(method === "HEAD" ? null : body, type);
}

/**
 * A crawler's answer for an address that is no page: a real 404, kept out of
 * search, rather than the sign-in card with the homepage as its canonical
 * (which reads as a soft 404 pointing every such address at `/`). Constant
 * bytes: nothing about the request reaches it.
 */
export const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found | Context.LC</title>
<meta name="robots" content="noindex">
</head>
<body>
<main>
<h1>Not found</h1>
<p>There is no page at this address.</p>
<p><a href="${ORIGIN}/">Open Context.LC</a></p>
</main>
</body>
</html>
`;

export function notFoundResponse(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "User-Agent",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
