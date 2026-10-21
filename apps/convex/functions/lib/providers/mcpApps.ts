/**
 * Apps Tex reaches through their official remote MCP server, each connected
 * with OAuth and a client Context registers with the app itself
 * (`mcpOAuth.ts`). Adding one is one line here once its server is checked to
 * offer dynamic client registration (`docs/decisions/connectors.md`). Each
 * address below answered an unauthenticated MCP `initialize` with 401 and its
 * OAuth metadata on 2026-10-21.
 */

import type { ProviderId } from "./ids";
import type { StandardSpec } from "./types";

function mcpApp(id: ProviderId, name: string, serverUrl: string, about: string): StandardSpec {
  return { kind: "mcp", id, name, about, serverUrl, callbackPath: `/connect/${id}`, client: { kind: "registered" }, scopes: [] };
}

export const linear = mcpApp("linear", "Linear", "https://mcp.linear.app/mcp", "find, create and update issues, projects and comments");
export const notion = mcpApp("notion", "Notion", "https://mcp.notion.com/mcp", "search, read and edit pages and databases");
export const atlassian = mcpApp(
  "atlassian",
  "Jira and Confluence",
  "https://mcp.atlassian.com/v1/mcp",
  "find and update Jira issues and Confluence pages",
);
export const airtable = mcpApp("airtable", "Airtable", "https://mcp.airtable.com/mcp", "read and edit bases, tables and records");
export const monday = mcpApp("monday", "monday.com", "https://mcp.monday.com/mcp", "read and update boards and items");
export const planningCenter = mcpApp(
  "planning-center",
  "Planning Center",
  "https://mcp.planningcenteronline.com/mcp",
  "see services, schedules, people, groups, check-ins, calendar and giving",
);
export const calendly = mcpApp("calendly", "Calendly", "https://mcp.calendly.com/", "see and manage scheduled meetings and event types");
export const clickup = mcpApp("clickup", "ClickUp", "https://mcp.clickup.com/mcp", "find, create and update tasks, lists and docs");
export const todoist = mcpApp("todoist", "Todoist", "https://ai.todoist.net/mcp", "read, add and complete tasks and projects");
