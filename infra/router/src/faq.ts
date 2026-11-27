/**
 * The homepage's questions, and the FAQPage structured data built from any
 * list of them. One list feeds both the visible page and its JSON-LD, so the
 * two cannot say different things (search engines require that they match).
 *
 * Every answer restates something the guides already say (`agentDocs.ts`).
 * No price but zero, no limit, no listing in any client's directory.
 */

import { CLAUDE_CODE_ADD, MCP_ENDPOINT } from "./agentFront";

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

export const FREE_ACCOUNT_SENTENCE = "Context does not charge for an account. A new address joins the waitlist.";

export const HOME_FAQ: readonly FaqEntry[] = [
  {
    question: "What is Context.LC?",
    answer:
      "Context.LC is a shared notes workspace for people, groups, and the AI tools they use. " +
      "ChatGPT, Claude, Cursor, and other MCP-compatible clients can read and write the same plain Markdown notes over MCP.",
  },
  {
    question: "How do I add Context to Claude?",
    answer:
      `In claude.ai, add a custom connector with the server URL ${MCP_ENDPOINT}, let Claude register the OAuth client automatically, ` +
      `then sign in to Context and approve. In Claude Code, run ${CLAUDE_CODE_ADD}, then /mcp to sign in. ` +
      "The full steps are at https://context.lc/claude.",
  },
  {
    question: "Is Context free?",
    answer: FREE_ACCOUNT_SENTENCE,
  },
  {
    question: "Where do my notes live?",
    answer: "Notes are plain Markdown files in storage you own. You can download everything as folders.",
  },
];

export function faqJsonLd(faq: readonly FaqEntry[], id: string): Record<string, unknown> {
  return {
    "@type": "FAQPage",
    "@id": id,
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}
