/**
 * The public agent docs: one markdown source per guide, served as markdown
 * and as HTML, plus /llms.txt. No auth, and the words match the gateway.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MCP_ENDPOINT } from "./agentFront";
import {
  CLAUDE_MARKDOWN,
  GROK_MARKDOWN,
  LLMS_TEXT,
  agentDocResponse,
  markdownToHtml,
  renderGuideHtml,
} from "./agentDocs";

const notesPage = readFileSync(
  fileURLToPath(new URL("../../../apps/mobile/features/landing/NotesPage.web.tsx", import.meta.url)),
  "utf8",
);

describe("agent docs", () => {
  it("llms.txt is plain text and points at both guides", async () => {
    const response = agentDocResponse("llms", "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(LLMS_TEXT);
    expect(body).toContain("# Context");
    expect(body).toContain(MCP_ENDPOINT);
    expect(body).toContain("https://context.lc/grokbot.md");
    expect(body).toContain("https://context.lc/claude.md");
    expect(body).toContain("https://context.lc/agents");
    expect(body).toContain("https://context.lc/claude");
  });

  it("the markdown guides are text/markdown and name the real endpoint", async () => {
    for (const [doc, source] of [
      ["grok-md", GROK_MARKDOWN],
      ["claude-md", CLAUDE_MARKDOWN],
    ] as const) {
      const response = agentDocResponse(doc, "GET");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      expect(await response.text()).toBe(source);
      expect(source).toContain(MCP_ENDPOINT);
      expect(source).not.toContain("https://mcp.context.lc/mcp/chatgpt");
      expect(source).not.toContain("https://@name/");
    }
    expect(GROK_MARKDOWN).toContain("https://mcp.context.lc/@name/mcp");
  });

  it("the HTML pages are the markdown, not a second copy", async () => {
    const grok = await agentDocResponse("agents", "GET").text();
    const claude = await agentDocResponse("claude", "GET").text();
    expect(agentDocResponse("agents", "GET").headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(grok).toContain(markdownToHtml(GROK_MARKDOWN));
    expect(claude).toContain(markdownToHtml(CLAUDE_MARKDOWN));
    expect(grok).toContain("<h1>Set up Context in Grok Bot</h1>");
    expect(claude).toContain("<h1>Set up Context in Claude</h1>");
    expect(grok).toContain(`<a href="/grokbot.md">Markdown</a>`);
    expect(claude).toContain(`<a href="/claude.md">Markdown</a>`);
    expect(grok).toContain(MCP_ENDPOINT);
    expect(claude).toContain("claude mcp add --transport http context https://mcp.context.lc/mcp");
  });

  it("does not ask for a session", () => {
    for (const doc of ["llms", "grok-md", "claude-md", "agents", "claude"] as const) {
      expect(agentDocResponse(doc, "GET").headers.get("WWW-Authenticate")).toBeNull();
      expect(agentDocResponse(doc, "POST").status).toBe(405);
    }
  });

  it("says only what the two clients actually do for a second account", () => {
    expect(GROK_MARKDOWN).toContain("Add a second account on the same connector");
    expect(GROK_MARKDOWN).toContain("Label each account with the person's name");
    expect(GROK_MARKDOWN).toContain("Tell the bot which label to use for whom");
    expect(GROK_MARKDOWN).toContain("does not use a cookie");
    expect(GROK_MARKDOWN).not.toContain("If this connector shows a way to add another account");
    expect(CLAUDE_MARKDOWN).toContain("Each member connects it and signs in with their own Context account");
    expect(CLAUDE_MARKDOWN).toContain("private notes stay private");
    expect(CLAUDE_MARKDOWN).toContain("One Claude login does not hold two Context accounts");
    expect(CLAUDE_MARKDOWN).not.toContain("separate Claude account");
    expect(CLAUDE_MARKDOWN).not.toContain("separate computer");
    expect(CLAUDE_MARKDOWN).toContain("Register automatically");
    expect(CLAUDE_MARKDOWN).toContain("Free can add one");
  });

  it("escapes markup in the guide renderer", () => {
    const html = renderGuideHtml("# Hi\n\n<script>alert(1)</script>\n", { path: "/agents", markdownPath: "/grokbot.md" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("the notes page links the same guides the index does", () => {
    expect(notesPage).toContain('href="/agents"');
    expect(notesPage).toContain('href="/claude"');
    expect(notesPage).toContain('href="/llms.txt"');
    expect(notesPage).toContain(MCP_ENDPOINT);
  });
});
