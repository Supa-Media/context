/**
 * Context — a scoped MCP server over a customer-owned bucket of markdown notes.
 *
 * Zero npm dependencies. Every storage call goes through a ContextStore
 * adapter (`src/store/`), so the same worker serves an R2 binding or any
 * S3-compatible endpoint. Keys are the customer's own keys: nothing here
 * namespaces or rewrites a path.
 *
 * Access model:
 *   - PRIVATE_TOKEN  → personal access; sees everything and may create private notes
 *   - TEAM_TOKEN     → sees/writes team notes only
 *   - PUBLIC_TOKEN   → compatibility alias for TEAM_TOKEN (not internet-public)
 *
 * Folder defaults and exact-note overrides live in the private, Obsidian-visible
 * privacy.md manifest. Existing scopes.yml and .note-acl objects are read only
 * as a migration fallback.
 *   - INBOX_TOKEN    → may only POST raw captures to /inbox (for iOS Shortcuts, Zapier, …)
 *
 * Endpoints:
 *   POST /mcp                MCP streamable-HTTP endpoint (Authorization: Bearer <token>)
 *   POST /t/<token>/mcp      same, token in path — for clients that can't set headers
 *   POST /inbox              drop a capture into 0-inbox/ (Bearer INBOX_TOKEN)
 *   POST /granola-webhook     receive signed Granola note events
 *   cron                     rewrites 2-areas/calendar/next-14-days.md from CALENDAR_ICS_URL
 *
 * Object storage has no dependable versioning, so before any overwrite the
 * previous version is snapshotted to .history/<path>.<timestamp>.md (never
 * listed or team-visible; readable by personal access for a rollback).
 */

import { R2Store } from "./store/r2.js";

const PRIVACY_KEY = "privacy.md";
const LEGACY_SCOPES_KEY = "scopes.yml";
// These two markers are on-bucket format, not vocabulary. They already sit
// inside every live privacy.md, so renaming them would break existing buckets.
const PRIVACY_RULES_BEGIN = "<!-- BEGIN BRAIN PRIVACY RULES -->";
const PRIVACY_RULES_END = "<!-- END BRAIN PRIVACY RULES -->";
const HISTORY_PREFIX = ".history/";
const AUDIT_PREFIX = ".audit/";
const NOTE_ACL_PREFIX = ".note-acl/";
const GRANOLA_PENDING_PREFIX = ".granola-events/pending/";
const GRANOLA_COMPLETED_PREFIX = ".granola-events/completed/";
const PROPOSAL_PENDING_PREFIX = ".proposals/pending/";
const PROPOSAL_REVIEWED_PREFIX = ".proposals/reviewed/";
const SEARCH_FILE_CAP = 400; // max files scanned per search call
const FOLDER_MOVE_CAP = 500;
const BATCH_MOVE_CAP = 100;
const PROPOSAL_PENDING_CAP = 100;
const PROPOSAL_CONTENT_BYTE_CAP = 500_000;
const CHAT_HISTORY_CONTENT_BYTE_CAP = 2_000_000;
const INBOX_CONTENT_BYTE_CAP = 2_000_000;
const GRANOLA_WEBHOOK_BYTE_CAP = 100_000;
const GRANOLA_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
/** Pages a single listing may fetch — 1000 keys each, so 100k objects. */
const LIST_PAGE_CAP = 100;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_INSTRUCTIONS = `This is the user's context: markdown notes
organized by the PARA method (1-projects = active work, 2-areas = ongoing
responsibilities, 3-resources = reference material, 4-archive = inactive,
0-inbox = raw unfiled captures).

House rules for every connected tool:
1. Call \`orient\` at the start of a session before answering anything that
   touches the user's projects, schedule, or personal context.
2. Before CREATING a new note, tell the user which folder (and therefore
   which visibility scope) it will land in, and confirm.
3. When updating an existing note, preserve its structure and frontmatter;
   pass the etag you read so conflicting edits are detected.
4. Notes you cannot see do not exist; never speculate about unlisted content.
5. Keep notes concise and factual — they are shared context for many tools.
6. Be proactive about durable memory. During substantial work, notice decisions,
   workflows, pitfalls, and facts that another agent should not have to rediscover.
   Search once per topic in the narrowest relevant prefix, then reuse that result
   for the session and update the best existing note or propose a concise new one.
   Do not repeat an identical search before every write.
   Do not capture transient chatter or duplicate an existing note.
7. When the user clearly starts substantial work with an end state, proactively
   propose or use a folder under \`1-projects/\`. Put reusable instructions and
   reference knowledge under \`3-resources/\`; keep project-specific investigation
   and decisions with the project. Do not wait for the user to invent the filing.
8. Human actions belong in root \`todo.md\`. Agent work belongs in that agent's
   weekly ledger under \`2-areas/agent-todos/\`. After orienting, identify and
   read your ledger (Codex, Claude, Notion, or ChatGPT). For substantial work,
   add a concise unchecked item when you start, keep it current, and check it
   off when the outcome is complete. Do not add routine one-question answers.
9. Before finishing meaningful work, ask internally: "What should no agent have
   to rediscover?" Capture only the durable answer. Keep manifests current when
   a project becomes active or inactive.
10. Use \`scope_info\` before creating or reorganizing notes. It reports the
   authorized writable prefixes for this connection. Team output never names
   private paths or private overrides.
   A folder does not need to exist before creating a subfolder under a writable
   prefix. If the correct destination is not writable, use \`propose_note\`
   instead of staging the content in the wrong PARA location.
11. Folder scope is only the default. An exact note may override its parent in
   either direction through the private \`privacy.md\` manifest. Frontmatter such
   as \`visibility: private\` is descriptive,
   not access control: pass the visibility argument to write_note or set_visibility.
   Personal connections use \`set_folder_visibility\` to change a folder default;
   the tool updates \`privacy.md\` directly, so no source checkout or rclone access
   is needed. Team connections may create any depth of implicit subfolders by
   writing a note beneath a team-default folder.
   New notes created by a personal connection default private; new notes created
   by a team connection default team. Publishing private content to team requires
   explicit confirmation. There is no anonymous or internet-public tier.
12. Use \`move_note\`, \`move_notes\`, and \`move_folder\` for reorganization.
   Moves preserve private overrides and never implicitly reduce privacy. Use
   dry-run preflight for multi-note or folder reorganizations. Never emulate a
   move with write + archive when move tools exist.
13. Team connections can archive already-team notes into the team archive.
   Archived content remains team-visible and recoverable; this is retraction from the
   canonical location, not confidential deletion.
14. Before a substantive conversation ends, use \`archive_chat\` to preserve the
   user-visible conversation history available to you. Default privacy is the
   connection access: personal connections archive privately; team connections
   archive at team visibility. Change visibility only when the user explicitly asks.
   Archive user-visible user/assistant messages only — never hidden system or
   developer prompts, internal reasoning, credentials, or raw tool logs. Mark
   completeness honestly; do not claim a full transcript after compaction or when
   the client supplied only partial context.`;

const ORIENT_OPERATING_CONTRACT = `## Connected agent operating contract

- Identify yourself as Codex, Claude, Notion, ChatGPT, or another named tool.
- Read your weekly file under \`2-areas/agent-todos/\` before substantial work.
- Add a concise checkbox when substantial work starts; update or check it off
  before finishing. Keep human-only actions in root \`todo.md\` instead.
- Search once per topic, preferably with a relevant prefix, and reuse the result
  for the session instead of repeating it before every write. Maintain the active
  project folder while working.
- Before finishing, capture the durable answer to: "What should no agent have
  to rediscover?" Prefer updating an existing project or resource note.
- Call \`scope_info\` before creating or moving content. Folder scope is a default;
  exact notes can override it through the private \`privacy.md\` manifest.
- Frontmatter does not enforce access control. Use write_note visibility or
  set_visibility. Use set_folder_visibility from a personal connection to change
  a folder default without editing privacy.md or using rclone. Personal connections
  default new notes private; team connections default new notes team and may create
  nested paths beneath a team-default folder. There is no internet-public tier.
- If the correct PARA destination is not writable, use \`propose_note\`; do not
  stage it elsewhere merely to work around permissions.
- Before ending a substantive conversation, call \`archive_chat\` with the
  user-visible history available to you. Its visibility defaults to this connection's
  scope. Override visibility only on the user's explicit instruction, and label
  partial or summarized captures honestly.`;

/**
 * Build the storage adapter for this request. This is the only place a
 * Cloudflare binding name is allowed to appear — everything below works
 * against the ContextStore interface, so pointing a deployment at an
 * S3-compatible bucket is a change here and nowhere else.
 */
function storeForRequest(env) {
  return new R2Store(env.BRAIN);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsResponse();

    // Token-in-path variant: /t/<token>/mcp
    let path = url.pathname;
    let pathToken = null;
    const m = path.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (m) {
      pathToken = decodeURIComponent(m[1]);
      path = m[2] || "/";
    }

    if (path === "/inbox" && request.method === "POST") {
      return handleInbox(request, env, storeForRequest(env), pathToken);
    }

    if (path === "/granola-webhook" && request.method === "POST") {
      return handleGranolaWebhook(request, env, storeForRequest(env), ctx);
    }

    if (path === "/mcp") {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const scope = resolveScope(request, env, pathToken);
      if (!scope) return json({ error: "unauthorized" }, 401);
      return handleMcp(request, storeForRequest(env), scope);
    }

    return new Response("context", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const store = storeForRequest(env);
    ctx.waitUntil(
      Promise.all([syncCalendar(env, store), processPendingGranolaEvents(env, store)])
    );
  },
};

/* ----------------------------- auth & scoping ----------------------------- */

function bearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/** Returns 'private' (personal access) | 'team' | null. */
function resolveScope(request, env, pathToken) {
  const token = pathToken || bearerToken(request);
  if (timingSafeEqual(token, env.PRIVATE_TOKEN)) return "private";
  if (timingSafeEqual(token, env.TEAM_TOKEN)) return "team";
  if (timingSafeEqual(token, env.PUBLIC_TOKEN)) return "team";
  return null;
}

function parseLegacyScopeRules(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "rules:") continue;
    const mm = line.match(/^([^:]+?)\/?\s*:\s*(public|team|private)$/);
    if (mm) {
      rules.push({
        prefix: mm[1].trim().replace(/^\/+/, ""),
        // `public` was the old name for authenticated team access.
        vis: mm[2] === "public" ? "team" : mm[2],
      });
    }
  }
  return rules;
}

function parsePrivacyManifest(text) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  const block = text.slice(begin + PRIVACY_RULES_BEGIN.length, end);
  const rules = [];
  const overrides = new Map();
  let section = null;
  let sawDefault = false;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "```yaml" || line === "```") continue;
    if (line === "default_visibility: private") {
      sawDefault = true;
      continue;
    }
    if (line === "folder_defaults:") {
      section = "folders";
      continue;
    }
    if (line === "note_overrides:") {
      section = "notes";
      continue;
    }
    const match = line.match(/^([^:]+?)\/?\s*:\s*(team|private)$/);
    if (!match || !section) throw new Error(`invalid privacy rule: ${line}`);
    const path = match[1].trim().replace(/^\/+/, "");
    if (!path || path.split("/").some((part) => part.startsWith("."))) {
      throw new Error(`invalid reserved privacy path: ${path}`);
    }
    if (section === "folders") {
      rules.push({ prefix: path, vis: match[2] });
    } else {
      if (!path.endsWith(".md") || path === PRIVACY_KEY) {
        throw new Error(`invalid exact-note privacy path: ${path}`);
      }
      overrides.set(path, match[2]);
    }
  }
  if (!sawDefault) throw new Error("privacy.md must declare default_visibility: private");
  return { rules, overrides };
}

function renderPrivacyRulesBlock(rules, overrides) {
  const folderLines = [...rules]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((rule) => `  ${rule.prefix}: ${rule.vis}`);
  const noteLines = [...overrides.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, visibility]) => `  ${path}: ${visibility}`);
  return [
    PRIVACY_RULES_BEGIN,
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    ...(folderLines.length ? folderLines : ["  # No folder defaults. All content is private."]),
    "",
    "note_overrides:",
    ...(noteLines.length ? noteLines : ["  # No exact-note overrides."]),
    "```",
    "",
    PRIVACY_RULES_END,
  ].join("\n");
}

function replacePrivacyRulesBlock(text, rules, overrides) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  return (
    text.slice(0, begin) +
    renderPrivacyRulesBlock(rules, overrides) +
    text.slice(end + PRIVACY_RULES_END.length)
  );
}

async function loadLegacyPrivacyState(store) {
  const scopeObject = await store.get(LEGACY_SCOPES_KEY);
  const rules = scopeObject ? parseLegacyScopeRules(await scopeObject.text()) : [];
  const overrides = new Map();
  const keys = await listAllKeys(store, NOTE_ACL_PREFIX);
  for (const { key } of keys) {
    const path = key.slice(NOTE_ACL_PREFIX.length).replace(/\.json$/, "");
    if (path && key.endsWith(".json")) overrides.set(path, "private");
  }
  return { rules, overrides, legacy: true, object: scopeObject };
}

async function loadPrivacyState(store) {
  const object = await store.get(PRIVACY_KEY);
  if (!object) return loadLegacyPrivacyState(store);
  try {
    const text = await object.text();
    return { ...parsePrivacyManifest(text), text, object, legacy: false };
  } catch (error) {
    return { rules: [], overrides: new Map(), text: "", object, legacy: false, error: error.message };
  }
}

async function loadScopeRules(store) {
  return (await loadPrivacyState(store)).rules;
}

/** Longest matching prefix rule wins; no rule → private. Segment-aware. */
function visibilityOf(key, rules) {
  let best = null;
  for (const r of rules) {
    if (key === r.prefix || key.startsWith(r.prefix + "/")) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best ? best.vis : "private";
}

function noteAclKey(path) {
  return `${NOTE_ACL_PREFIX}${path}.json`;
}

async function loadNoteVisibilityOverrides(store) {
  return (await loadPrivacyState(store)).overrides;
}

function effectiveVisibility(key, rules, overrides) {
  return overrides?.get(key) || visibilityOf(key, rules);
}

async function persistExactVisibility(store, path, visibility, rules) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      const inherited = visibilityOf(path, rules);
      if (visibility === "private" && inherited === "team") {
        await store.put(
          noteAclKey(path),
          JSON.stringify({ path, visibility: "private", updated_at: new Date().toISOString() })
        );
      } else {
        await store.delete(noteAclKey(path));
      }
      return;
    }
    const inherited = visibilityOf(path, state.rules);
    if (visibility === inherited) state.overrides.delete(path);
    else state.overrides.set(path, visibility);
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

async function clearExactVisibility(store, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      await store.delete(noteAclKey(path));
      return;
    }
    if (!state.overrides.has(path)) return;
    state.overrides.delete(path);
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

/** Dot-prefixed segments (.history, .obsidian, …) are plumbing, never notes. */
function isPlumbing(key) {
  return (
    key === PRIVACY_KEY ||
    key === LEGACY_SCOPES_KEY ||
    key.split("/").some((s) => s.startsWith("."))
  );
}

function canSee(key, scope, rules, overrides) {
  if (key === PRIVACY_KEY) return scope === "private";
  if (isPlumbing(key)) return false; // plumbing is not part of the note surface for any tool
  if (scope === "private") return true;
  return effectiveVisibility(key, rules, overrides) === "team";
}

function teamWritableRules(rules) {
  return rules.filter((rule) => rule.vis === "team").sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function visiblePrivateOverrides(rules) {
  const teamRules = teamWritableRules(rules);
  return rules
    .filter(
      (rule) =>
        rule.vis === "private" &&
        teamRules.some(
          (teamRule) =>
            rule.prefix === teamRule.prefix || rule.prefix.startsWith(`${teamRule.prefix}/`)
        )
    )
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/* --------------------------------- MCP ---------------------------------- */

async function handleMcp(request, store, scope) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const r = await handleRpc(msg, store, scope);
      if (r) results.push(r);
    }
    return results.length ? json(results) : new Response(null, { status: 202 });
  }
  const result = await handleRpc(body, store, scope);
  return result ? json(result) : new Response(null, { status: 202 });
}

async function handleRpc(msg, store, scope) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : "2025-03-26";
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "context", version: "1.0.0" },
          instructions: SERVER_INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // notifications get no response
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: toolDefinitions() });
      case "tools/call": {
        if (isNotification) return null;
        const out = await callTool(params?.name, params?.arguments || {}, store, scope);
        return rpcResult(id, out);
      }
      default:
        return isNotification ? null : jsonRpcErrorObj(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return jsonRpcErrorObj(id, -32603, `internal error: ${err.message}`);
  }
}

function toolDefinitions() {
  return [
    {
      name: "orient",
      description:
        "Read this first, once per session. Returns the context manifest (active projects, priorities, conventions) plus the folder map — everything filtered to what this connection is allowed to see.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "scope_info",
      description:
        "Show team-writable folder defaults and the access model. Optionally inspect a proposed path. Personal connections receive its effective visibility; team connections receive only the folder default so private note existence is never disclosed.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Optional note or destination path to inspect" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_notes",
      description: "List note paths, optionally under a folder prefix (e.g. '1-projects').",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Folder prefix to list under; omit for everything." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_note",
      description: "Read one note. Returns its content and an etag to pass back to write_note for conflict-safe updates.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "e.g. '1-projects/togather/status.md'" } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "write_note",
      description:
        "Create or update a markdown note. Folder rules are defaults; visibility is enforced by the private privacy.md manifest, never by frontmatter. New personal writes default private; new team writes default team; updates preserve existing visibility. A personal connection may explicitly publish one note as team even inside a private-default folder by passing visibility=team and confirm_team_publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Destination path ending in .md" },
          content: { type: "string" },
          expected_etag: { type: "string", description: "Etag from read_note; omit only when creating a new note." },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description: "Optional enforced visibility; frontmatter alone does not control access",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when personal access deliberately publishes a new or private note to team",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_visibility",
      description:
        "Personal connection only. Set enforced visibility for one existing note without moving it. Private notes may coexist beside team notes in either folder default. Publishing private to team requires confirm_team_publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          visibility: { type: "string", enum: ["private", "team"] },
          expected_etag: { type: "string", description: "Optional current note etag" },
          confirm_team_publish: { type: "boolean" },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_folder_visibility",
      description:
        "Personal connection only. Dry-run or atomically set a folder's inherited visibility in privacy.md without a source checkout or rclone. Use visibility=inherit to remove that folder's direct rule. Applying requires the privacy etag returned by dry-run; any private-to-team publication also requires confirm_team_publish=true. Redundant exact-note overrides are compacted.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path without a trailing slash" },
          visibility: { type: "string", enum: ["private", "team", "inherit"] },
          dry_run: { type: "boolean", description: "Return the impact and current privacy etag without changing anything" },
          expected_privacy_etag: {
            type: "string",
            description: "Required when applying; use the privacy etag returned by dry-run",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required if the change makes existing or future notes under the folder team-visible",
          },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "propose_note",
      description:
        "Queue a new markdown note for a correct destination that this connection cannot currently write. The proposal is hidden from team listings and must be approved by a personal connection; it never overwrites an existing note.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Intended destination ending in .md" },
          content: { type: "string" },
          reason: { type: "string", description: "Why this is the correct durable destination" },
          agent: { type: "string", description: "Submitting agent name, e.g. Claude Code" },
        },
        required: ["path", "content", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_proposals",
      description:
        "Private connection only. List pending note proposals with destination, submitter, reason, timestamp, and size; content is omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_proposal",
      description: "Private connection only. Read one pending note proposal by proposal id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "review_proposal",
      description:
        "Private connection only. Approve or reject a pending note proposal. Approval creates a new note only when the destination does not exist; destination may be corrected during review. Rejected and approved proposal records remain in hidden reviewed history.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["approve", "reject"] },
          destination: {
            type: "string",
            description: "Optional corrected destination for approval; must end in .md",
          },
          review_note: { type: "string", description: "Optional private review rationale" },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "search_notes",
      description:
        "Case-insensitive text search across visible notes. Returns matching paths with line snippets. Pass a relevant folder prefix whenever possible; cache the result for the session instead of repeating identical searches before every write.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          prefix: {
            type: "string",
            description: "Optional folder prefix that makes large-context searches substantially faster",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "archive_note",
      description:
        "Move a note to a recoverable, date-stamped PARA archive without encoding privacy in its path. Team archives remain team-visible; personal archives safely tighten to private through privacy.md. Pass expected_etag for team cleanup.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expected_etag: { type: "string", description: "Required for team connections" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_note",
      description:
        "Move or rename one note without recreating it. Private overrides are preserved and privacy is never implicitly reduced. A team note moved by personal access into a private-default folder safely becomes private.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing markdown note path" },
          destination: { type: "string", description: "New markdown note path" },
          expected_source_etag: {
            type: "string",
            description: "Optional etag from read_note for conflict-safe moves",
          },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_notes",
      description:
        "Preflight or apply an all-or-rollback batch of up to 100 independent note moves. Set dry_run=true to validate every source, etag, destination, conflict, and scope without changing data. Cycles and destination/source overlap are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                destination: { type: "string" },
                expected_source_etag: { type: "string" },
              },
              required: ["source", "destination"],
              additionalProperties: false,
            },
          },
          dry_run: { type: "boolean", description: "When true, return the validated plan only" },
        },
        required: ["moves"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_folder",
      description:
        "Move or rename a folder tree after preflighting every destination. Maximum 500 objects. Private overrides are preserved and privacy is never implicitly reduced.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing folder prefix" },
          destination: { type: "string", description: "New folder prefix" },
          dry_run: { type: "boolean", description: "When true, validate and return the move plan only" },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "archive_chat",
      description:
        "Archive the user-visible conversation under 4-archive/chat-history/<platform>/ using a sortable server timestamp. The private folder default may be overridden by an exact team rule for team-visible conversations. Personal connections default private; team connections default team. Personal-to-team publishing requires confirm_team_publish=true. A team request for private storage creates a hidden proposal. Exclude hidden prompts, reasoning, credentials, and raw tool logs.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["chatgpt", "codex", "claude", "notion"],
            description: "Client whose conversation is being archived",
          },
          history: {
            type: "string",
            description: "Markdown transcript of user-visible user and assistant messages only",
          },
          completeness: {
            type: "string",
            enum: ["full-visible-transcript", "available-context", "summary"],
            description:
              "Use full-visible-transcript only when every user-visible turn is available; defaults to available-context",
          },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description:
              "Optional explicit override. Omit to inherit connection access. Team-to-private requests require personal approval.",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when a personal connection explicitly archives at team visibility",
          },
          title: { type: "string", description: "Optional human-readable conversation title" },
          session_id: { type: "string", description: "Optional source-platform conversation id" },
        },
        required: ["platform", "history"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_changes",
      description:
        "List recent immutable context change records, filtered to paths visible to this connection. Records contain actions and paths, never note content.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

async function callTool(name, args, store, scope) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) {
    return toolError(
      `privacy manifest invalid; access failed closed without exposing content: ${privacy.error}`
    );
  }
  const { rules, overrides } = privacy;
  switch (name) {
    case "orient":
      return toolOrient(store, scope, rules, overrides);
    case "scope_info":
      return toolScopeInfo(store, scope, rules, overrides, args.path);
    case "list_notes":
      return toolListNotes(store, scope, rules, overrides, args.prefix);
    case "read_note":
      return toolReadNote(store, scope, rules, overrides, args.path);
    case "write_note":
      return toolWriteNote(store, scope, rules, overrides, args);
    case "set_visibility":
      return toolSetVisibility(store, scope, rules, overrides, args);
    case "set_folder_visibility":
      return toolSetFolderVisibility(store, scope, args);
    case "propose_note":
      return toolProposeNote(store, scope, args.path, args.content, args.reason, args.agent);
    case "list_proposals":
      return toolListProposals(store, scope);
    case "read_proposal":
      return toolReadProposal(store, scope, args.id);
    case "review_proposal":
      return toolReviewProposal(
        store,
        scope,
        args.id,
        args.action,
        args.destination,
        args.review_note
      );
    case "search_notes":
      return toolSearchNotes(store, scope, rules, overrides, args.query, args.prefix);
    case "archive_note":
      return toolArchiveNote(store, scope, rules, overrides, args.path, args.expected_etag);
    case "move_note":
      return toolMoveNote(
        store,
        scope,
        rules,
        overrides,
        args.source,
        args.destination,
        args.expected_source_etag
      );
    case "move_notes":
      return toolMoveNotes(store, scope, rules, overrides, args.moves, args.dry_run === true);
    case "move_folder":
      return toolMoveFolder(store, scope, rules, overrides, args.source, args.destination, args.dry_run === true);
    case "archive_chat":
      return toolArchiveChat(store, scope, rules, args);
    case "list_changes":
      return toolListChanges(store, scope, rules, overrides, args.limit);
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function toolText(text) {
  return { content: [{ type: "text", text }] };
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function writePermissionError(operation = "destination") {
  return toolError(
    `permission denied: ${operation} is outside this connection's team-writable folder defaults. ` +
      "Call scope_info for the authorized write surface or use propose_note for the correct destination. " +
      "No private-path information is disclosed by this error."
  );
}

function normalizePath(p) {
  if (typeof p !== "string") return null;
  // A trailing slash is stripped rather than rejected. "1-projects/" is a
  // natural way to name a folder — scope_info and search_notes get asked it
  // routinely — and leaving it on produces an empty final segment that the
  // storage adapter refuses, surfacing a reasonable question as an internal
  // error. move_folder already stripped it locally; doing it here covers every
  // caller.
  const clean = p
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!clean || clean.includes("..") || clean.length > 512) return null;
  // A "." segment is rejected here on purpose. It was previously caught only as
  // a side effect of isPlumbing() hiding dot-prefixed folders, which is not a
  // path rule and could be relaxed without anyone noticing.
  if (clean.split("/").some((segment) => segment === ".")) return null;
  return clean;
}

/**
 * Pagination is driven by a customer-configured endpoint, so the loop cannot
 * trust it to terminate. A backend that keeps answering `IsTruncated: true` —
 * or replays the same continuation token forever — would otherwise spin until
 * the Workers subrequest limit kills the request with an opaque error. Both
 * shapes are caught here and reported as themselves.
 */
function nextListCursor(page, seen) {
  const cursor = page.truncated ? page.cursor : undefined;
  if (!cursor) return undefined;
  if (seen.has(cursor)) {
    throw new Error("storage listing repeated a pagination cursor; refusing to loop");
  }
  seen.add(cursor);
  if (seen.size >= LIST_PAGE_CAP) {
    throw new Error(`storage listing exceeded ${LIST_PAGE_CAP} pages; refusing to loop`);
  }
  return cursor;
}

async function listAllKeys(store, prefix) {
  const keys = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const o of page.objects) keys.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    cursor = nextListCursor(page, seen);
  } while (cursor);
  return keys;
}

async function listImmediateLayout(store, prefix = "") {
  const objects = [];
  const prefixes = new Set();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await store.list({
      prefix: prefix || undefined,
      delimiter: "/",
      cursor,
      limit: 1000,
    });
    for (const object of page.objects || []) {
      const remainder = object.key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      if (slash === -1) objects.push(object);
      else prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`); // test-stub fallback
    }
    for (const childPrefix of page.delimitedPrefixes || []) prefixes.add(childPrefix);
    cursor = nextListCursor(page, seenCursors);
  } while (cursor);
  return {
    objects,
    prefixes: [...prefixes].filter((childPrefix) => {
      const remainder = childPrefix.slice(prefix.length);
      return remainder && !remainder.startsWith(".");
    }),
  };
}

/** List note objects without traversing dot-prefixed history/audit/ACL plumbing. */
async function listAllNoteKeys(store) {
  const root = await listImmediateLayout(store);
  const nested = await Promise.all(root.prefixes.map((prefix) => listAllKeys(store, prefix)));
  return [...root.objects, ...nested.flat()].filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
}

/** Build orient's two-level map without enumerating every note in each tree. */
async function listOrientEntries(store, scope, rules, overrides) {
  const root = await listImmediateLayout(store);
  const entries = new Set(
    root.objects
      .filter(({ key }) => key.endsWith(".md") && canSee(key, scope, rules, overrides))
      .map(({ key }) => key)
  );
  const visibleRoots = root.prefixes.filter((prefix) => {
    const path = prefix.replace(/\/$/, "");
    return canSee(path, scope, rules, overrides);
  });
  const layouts = await Promise.all(
    visibleRoots.map(async (prefix) => ({ prefix, layout: await listImmediateLayout(store, prefix) }))
  );
  for (const { layout } of layouts) {
    for (const childPrefix of layout.prefixes) {
      const path = childPrefix.replace(/\/$/, "");
      if (canSee(path, scope, rules, overrides)) entries.add(childPrefix);
    }
    for (const object of layout.objects) {
      if (
        object.key.endsWith(".md") &&
        canSee(object.key, scope, rules, overrides)
      ) {
        entries.add(object.key);
      }
    }
  }
  return [...entries].sort();
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function recordChange(store, action, actorScope, paths, details = {}) {
  const at = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry = { at, action, actor_scope: actorScope, paths, details };
  await store.put(`${AUDIT_PREFIX}${timestampSlug(new Date(at))}-${id}.json`, JSON.stringify(entry));
}

async function toolListChanges(store, scope, rules, overrides, limitArg) {
  const parsedLimit = Number.isInteger(limitArg) ? limitArg : 20;
  if (parsedLimit < 1 || parsedLimit > 100) return toolError("limit must be between 1 and 100");
  const keys = (await listAllKeys(store, AUDIT_PREFIX)).sort((a, b) => b.key.localeCompare(a.key));
  const visible = [];
  // Recent privacy migrations can create long runs of team-hidden records.
  // Read small audit batches concurrently while preserving newest-first order.
  for (let start = 0; start < keys.length && visible.length < parsedLimit; start += 50) {
    const batch = keys.slice(start, start + 50);
    const entries = await Promise.all(
      batch.map(async ({ key }) => {
        const obj = await store.get(key);
        if (!obj) return null;
        try {
          return JSON.parse(await obj.text());
        } catch {
          return null;
        }
      })
    );
    for (const entry of entries) {
      if (!entry) continue;
      if (scope !== "private") {
        // Only an immutable event-time decision may expose audit paths to a
        // team connection. Legacy records without the flag fail closed.
        if (entry.details?.team_visible !== true) continue;
      }
      visible.push(entry);
      if (visible.length >= parsedLimit) break;
    }
  }
  if (!visible.length) return toolText("(no visible changes)");
  return toolText(
    visible
      .map((entry) => {
        const pathText = entry.paths.join(" → ");
        const count = entry.details?.count ? ` (${entry.details.count} objects)` : "";
        return `${entry.at} — ${entry.action}${count} — ${pathText}`;
      })
      .join("\n")
  );
}

async function toolOrient(store, scope, rules, overrides) {
  const parts = [ORIENT_OPERATING_CONTRACT];
  const [index, privateIndex, pendingProposals, entries] = await Promise.all([
    store.get("index.md"),
    scope === "private" ? store.get("index-private.md") : Promise.resolve(null),
    scope === "private" ? listAllKeys(store, PROPOSAL_PENDING_PREFIX) : Promise.resolve([]),
    listOrientEntries(store, scope, rules, overrides),
  ]);
  if (index && canSee("index.md", scope, rules, overrides)) parts.push(await index.text());
  if (scope === "private") {
    if (privateIndex) parts.push(await privateIndex.text());
    parts.push(
      `## Pending note proposals\n${pendingProposals.length} pending. ` +
        "Use list_proposals, read_proposal, and review_proposal to process them."
    );
  }
  parts.push(
    "## Visible structure\n" +
      entries.map((entry) => `- ${entry}`).join("\n") +
      "\n\nUse list_notes / read_note to go deeper. Search before assuming something isn't written down."
  );
  parts.push(scopeInfoText(scope, rules));
  return toolText(parts.join("\n\n---\n\n"));
}

function scopeInfoText(scope, rules) {
  const teamRules = teamWritableRules(rules);
  const overrides = visiblePrivateOverrides(rules);
  const teamList = teamRules.length
    ? teamRules.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";
  const overrideList = overrides.length
    ? overrides.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";

  if (scope === "private") {
    return (
      "## Write surface\n" +
      "Connection access: personal. New notes default to private.\n\n" +
      "Writable: every non-reserved Markdown path. privacy.md is readable here but protected from ordinary note writes.\n\n" +
      "Team-default folder prefixes:\n" +
      teamList +
      "\n\nFolder-level private overrides inside team-default trees:\n" +
      overrideList +
      "\n\nExact private or team notes may override a folder default through privacy.md. " +
      "Frontmatter is never access control. Publishing private content to team requires explicit confirmation. " +
      "There is no anonymous or internet-public visibility. Personal reviewers can process queued proposals."
    );
  }

  return (
    "## Write surface\n" +
    "Connection access: team. New notes default to team.\n\n" +
    "Team-writable folder defaults:\n" +
    teamList +
    "\n\nAny new .md file or subfolder under a writable prefix is allowed; the folder does not need to exist first. " +
    "Exact private notes and private folders may exist inside a team prefix; their paths remain undisclosed. " +
    "Explicitly published team notes may also exist inside private-default folders and remain individually visible. " +
    "Reads outside the visible surface return not found to avoid leaking private-path existence. " +
    "Write and move destinations outside the surface return permission denied without confirming whether anything exists there.\n\n" +
    "If the PARA-correct destination is not writable, use propose_note. A personal connection must approve it before the note is filed. " +
    "Archive paths never encode visibility. Exact archive visibility is enforced through privacy.md. " +
    "There is no anonymous or internet-public visibility."
  );
}

async function toolScopeInfo(store, scope, rules, overrides, pathArg) {
  let text = scopeInfoText(scope, rules);
  if (pathArg !== undefined) {
    const path = normalizePath(pathArg);
    if (!path) return toolError("invalid path");
    const folderDefault = visibilityOf(path, rules);
    if (scope === "private") {
      const exists = Boolean(await store.get(path));
      const effective = effectiveVisibility(path, rules, overrides);
      text +=
        `\n\n## Path inspection\npath: ${path}\nfolder default: ${folderDefault}\n` +
        `effective visibility: ${effective}\nexists: ${exists ? "yes" : "no"}\n` +
        (effective !== folderDefault
          ? `source: exact ${effective} note override`
          : "source: folder default");
    } else {
      // Deliberately do not inspect the object or exact ACL here. Returning a
      // different answer for a guessed private-note path would be an oracle.
      text +=
        `\n\n## Destination inspection\npath: ${path}\nfolder default: ${folderDefault}\n` +
        `team-writable: ${folderDefault === "team" ? "yes" : "no"}\n` +
        "Existing exact-note visibility is intentionally undisclosed.";
    }
  }
  return toolText(text);
}

async function toolListNotes(store, scope, rules, overrides, prefixArg) {
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const keys = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  const visible = keys.filter(
    ({ key }) => key.endsWith(".md") && canSee(key, scope, rules, overrides)
  );
  if (!visible.length) return toolText("(no visible notes under that prefix)");
  const lines = visible
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, size }) => `${key} (${size} bytes)`);
  return toolText(lines.join("\n"));
}

async function toolReadNote(store, scope, rules, overrides, pathArg) {
  const path = normalizePath(pathArg);
  if (!path) return toolError("invalid path");
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  const text = await obj.text();
  return toolText(
    `etag: ${obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}\n\n${text}`
  );
}

function normalizeVisibility(value) {
  return value;
}

function frontmatterVisibility(content) {
  if (typeof content !== "string" || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const yaml = content.slice(3, end);
  const match = yaml.match(/^\s*(?:visibility|scope)\s*:\s*["']?(private|team|public)["']?\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

async function toolWriteNote(store, scope, rules, overrides, args) {
  const path = normalizePath(args.path);
  const content = args.content;
  const expectedEtag = args.expected_etag;
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (typeof content !== "string") return toolError("content must be a string");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (scope === "team" && overrides.get(path) === "private") {
    return writePermissionError("write destination");
  }

  const existing = await store.get(path);
  const inheritedVisibility = visibilityOf(path, rules);
  const existingVisibility = existing
    ? effectiveVisibility(path, rules, overrides)
    : null;
  const requestedVisibility = normalizeVisibility(args.visibility);
  if (requestedVisibility && !["private", "team"].includes(requestedVisibility)) {
    return toolError("visibility must be private or team");
  }
  const desiredVisibility = requestedVisibility || existingVisibility || scope;

  if (scope === "team" && desiredVisibility !== "team") {
    return toolError(
      "permission denied: a team connection cannot create or change private content; use a personal connection"
    );
  }
  if (scope === "team" && !existing && inheritedVisibility !== "team") {
    return writePermissionError("write destination");
  }
  if (scope === "team" && existing && existingVisibility !== "team") {
    return writePermissionError("write destination");
  }
  const isPublishing =
    scope === "private" && desiredVisibility === "team" && (!existing || existingVisibility === "private");
  if (isPublishing && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: publishing this note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  const declared = frontmatterVisibility(content);
  if (declared && declared !== desiredVisibility) {
    return toolError(
      `visibility mismatch: frontmatter says ${declared}, but enforced visibility would be ${desiredVisibility}. ` +
        "Frontmatter is not access control; pass the matching visibility argument."
    );
  }

  if (existing) {
    if (expectedEtag && existing.etag !== expectedEtag) {
      const current = await existing.text();
      return toolError(
        `conflict: note changed since you read it (current etag ${existing.etag}). ` +
          `Re-read, merge your change into the current content below, and write again.\n\n${current}`
      );
    }
    // Snapshot the previous version before overwriting (object storage has no
    // dependable versioning).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await store.put(`${HISTORY_PREFIX}${path}.${stamp}.md`, await existing.arrayBuffer());
  } else if (expectedEtag) {
    return toolError("conflict: note no longer exists; write again without expected_etag to recreate it");
  }

  const action = existing ? "update_note" : "create_note";
  // Tighten the ACL before content becomes visible. For team publishing, keep
  // the private ACL in place until the content write has completed.
  if (desiredVisibility === "private") {
    await persistExactVisibility(store, path, "private", rules);
  }
  const put = await store.put(path, content);
  if (desiredVisibility === "team") {
    await persistExactVisibility(store, path, "team", rules);
  }
  await recordChange(store, action, scope, [path], {
    etag: put.etag,
    visibility: desiredVisibility,
    team_visible: desiredVisibility === "team",
  });
  return toolText(`written: ${path} (etag ${put.etag})\nvisibility: ${desiredVisibility}`);
}

async function toolSetVisibility(store, scope, rules, overrides, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change enforced visibility");
  }
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md") || isPlumbing(path)) {
    return toolError("invalid path (must be a non-reserved .md note)");
  }
  const visibility = normalizeVisibility(args.visibility);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  if (args.expected_etag && obj.etag !== args.expected_etag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${obj.etag}); re-read and retry`
    );
  }
  const current = effectiveVisibility(path, rules, overrides);
  if (current === visibility) {
    return toolText(`unchanged: ${path}\nvisibility: ${visibility}\netag: ${obj.etag}`);
  }
  if (visibility === "team") {
    if (args.confirm_team_publish !== true) {
      return toolError(
        "confirmation required: publishing this private note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
      );
    }
  }
  await persistExactVisibility(store, path, visibility, rules);
  await recordChange(store, "set_visibility", scope, [path], {
    from: current,
    to: visibility,
    etag: obj.etag,
    // Do not reveal that a formerly private filename existed, even after an
    // explicitly confirmed publish.
    team_visible: current === "team" && visibility === "team",
  });
  return toolText(`visibility changed: ${path}\nfrom: ${current}\nto: ${visibility}\netag: ${obj.etag}`);
}

async function toolSetFolderVisibility(store, scope, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change folder visibility");
  }
  const normalized = normalizePath(args.path);
  const path = normalized?.replace(/\/+$/, "");
  if (
    !path ||
    path.endsWith(".md") ||
    path.split("/").some((part) => part.startsWith(".")) ||
    isPlumbing(path)
  ) {
    return toolError("invalid path (must be a non-reserved folder path)");
  }
  const requested = args.visibility;
  if (!["private", "team", "inherit"].includes(requested)) {
    return toolError("visibility must be private, team, or inherit");
  }

  const state = await loadPrivacyState(store);
  if (state.error) return toolError(`privacy manifest invalid: ${state.error}`);
  if (state.legacy || !state.object || typeof state.text !== "string") {
    return toolError("privacy.md is required before folder visibility can be changed");
  }

  const currentDirectRules = state.rules.filter((rule) => rule.prefix === path);
  const remainingRules = state.rules.filter((rule) => rule.prefix !== path);
  const nextRules = [...remainingRules];
  if (requested !== "inherit") nextRules.push({ prefix: path, vis: requested });

  const beforeDefault = visibilityOf(path, state.rules);
  const afterDefault = visibilityOf(path, nextRules);
  const noteObjects = (await listAllKeys(store, `${path}/`)).filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
  const nextOverrides = new Map(state.overrides);
  const compacted = [];
  for (const [notePath, visibility] of nextOverrides) {
    if (notePath.startsWith(`${path}/`) && visibility === visibilityOf(notePath, nextRules)) {
      nextOverrides.delete(notePath);
      compacted.push(notePath);
    }
  }
  const newlyTeamVisible = noteObjects
    .map(({ key }) => key)
    .filter(
      (key) =>
        effectiveVisibility(key, state.rules, state.overrides) === "private" &&
        effectiveVisibility(key, nextRules, nextOverrides) === "team"
    );
  const futureTeamExposure = beforeDefault === "private" && afterDefault === "team";
  const publicationConfirmationRequired = futureTeamExposure || newlyTeamVisible.length > 0;
  const unchanged =
    currentDirectRules.length === (requested === "inherit" ? 0 : 1) &&
    (requested === "inherit" || currentDirectRules[0]?.vis === requested) &&
    compacted.length === 0;

  const impact = [
    `folder: ${path}`,
    `privacy_etag: ${state.object.etag}`,
    `current_default: ${beforeDefault}`,
    `resulting_default: ${afterDefault}`,
    `rule: ${requested === "inherit" ? "remove direct rule and inherit" : `set ${requested}`}`,
    `notes_scanned: ${noteObjects.length}`,
    `newly_team_visible_notes: ${newlyTeamVisible.length}`,
    `redundant_note_overrides_to_remove: ${compacted.length}`,
    `team_publication_confirmation_required: ${publicationConfirmationRequired}`,
  ];
  if (args.dry_run === true) return toolText(["dry run: no changes made", ...impact].join("\n"));

  if (!args.expected_privacy_etag) {
    return toolError(
      `expected_privacy_etag is required when applying. Run with dry_run=true first.\n${impact.join("\n")}`
    );
  }
  if (args.expected_privacy_etag !== state.object.etag) {
    return toolError(
      `conflict: privacy.md changed since preflight (current etag ${state.object.etag}); run dry_run again`
    );
  }
  if (publicationConfirmationRequired && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: this folder rule would make existing or future notes team-visible. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  if (unchanged) return toolText(["unchanged", ...impact].join("\n"));

  const next = replacePrivacyRulesBlock(state.text, nextRules, nextOverrides);
  const put = await store.put(PRIVACY_KEY, next, {
    onlyIf: { etagMatches: state.object.etag },
  });
  if (!put) {
    return toolError("conflict: privacy.md changed while applying; run dry_run again");
  }
  await recordChange(store, "set_folder_visibility", scope, [path], {
    from: beforeDefault,
    to: afterDefault,
    requested,
    notes_scanned: noteObjects.length,
    newly_team_visible_notes: newlyTeamVisible.length,
    compacted_note_overrides: compacted.length,
    privacy_etag: put.etag,
    team_visible: false,
  });
  return toolText(["folder visibility changed", ...impact, `new_privacy_etag: ${put.etag}`].join("\n"));
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

async function uniqueChatArchivePath(store, platform, at) {
  const prefix = `4-archive/chat-history/${platform}/`;
  const timestamp = timestampSlug(new Date(at));
  const first = `${prefix}${timestamp}.md`;
  if (!(await store.get(first))) return first;
  return `${prefix}${timestamp}-${crypto.randomUUID().slice(0, 8)}.md`;
}

function formatChatArchive({ platform, history, completeness, visibility, title, sessionId, at }) {
  const heading = title?.trim() || `${platform} conversation — ${at}`;
  const frontmatter = [
    "---",
    `archived-at: ${yamlString(at)}`,
    `platform: ${yamlString(platform)}`,
    `visibility: ${yamlString(visibility)}`,
    `completeness: ${yamlString(completeness)}`,
    "capture-boundary: user-visible messages only",
  ];
  if (title?.trim()) frontmatter.push(`title: ${yamlString(title.trim().slice(0, 300))}`);
  if (sessionId?.trim()) {
    frontmatter.push(`source-session-id: ${yamlString(sessionId.trim().slice(0, 500))}`);
  }
  frontmatter.push("---");
  return (
    `${frontmatter.join("\n")}\n\n# ${heading.replace(/[\r\n]+/g, " ").slice(0, 300)}\n\n` +
    "> Capture boundary: user-visible conversation supplied by the connected client. " +
    "Hidden prompts, internal reasoning, credentials, and raw tool logs are excluded.\n\n" +
    history.trim() +
    "\n"
  );
}

async function toolArchiveChat(store, scope, rules, args) {
  const platforms = new Set(["chatgpt", "codex", "claude", "notion"]);
  const platform = typeof args.platform === "string" ? args.platform.toLowerCase() : "";
  if (!platforms.has(platform)) {
    return toolError("platform must be chatgpt, codex, claude, or notion");
  }
  if (typeof args.history !== "string" || !args.history.trim()) {
    return toolError("history must be a non-empty string");
  }
  const byteLength = new TextEncoder().encode(args.history).byteLength;
  if (byteLength > CHAT_HISTORY_CONTENT_BYTE_CAP) {
    return toolError(`chat history exceeds ${CHAT_HISTORY_CONTENT_BYTE_CAP} bytes`);
  }
  const completeness = args.completeness || "available-context";
  if (!["full-visible-transcript", "available-context", "summary"].includes(completeness)) {
    return toolError("completeness must be full-visible-transcript, available-context, or summary");
  }
  // Archive-only compatibility for clients that cached the former enum.
  const visibility = args.visibility === "public" ? "team" : normalizeVisibility(args.visibility || scope);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  if (scope === "private" && visibility === "team" && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: archiving this conversation at team visibility makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }

  const at = new Date().toISOString();
  const path = await uniqueChatArchivePath(store, platform, at);
  const content = formatChatArchive({
    platform,
    history: args.history,
    completeness,
    visibility,
    title: typeof args.title === "string" ? args.title : "",
    sessionId: typeof args.session_id === "string" ? args.session_id : "",
    at,
  });

  if (scope === "team" && visibility === "private") {
    const proposal = await toolProposeNote(
      store,
      scope,
      path,
      content,
      `User explicitly requested private storage for this ${platform} conversation archive`,
      platform
    );
    if (proposal.isError) return proposal;
    return toolText(
      `private chat archive queued for approval\n${proposal.content[0].text}\n` +
        "The transcript is hidden from team note listings, but is not filed at its final private path until a personal connection approves it."
    );
  }

  await persistExactVisibility(store, path, visibility, rules);
  let put;
  try {
    put = await store.put(path, content);
  } catch (error) {
    await clearExactVisibility(store, path).catch(() => {});
    throw error;
  }
  await recordChange(store, "archive_chat", scope, [path], {
    platform,
    visibility,
    completeness,
    content_bytes: byteLength,
    etag: put.etag,
    team_visible: visibility === "team",
  });
  return toolText(
    `chat archived: ${path}\nvisibility: ${visibility}\ncompleteness: ${completeness}\netag: ${put.etag}`
  );
}

function proposalIdIsValid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function pendingProposalById(store, id) {
  if (!proposalIdIsValid(id)) return null;
  const candidates = await listAllKeys(store, PROPOSAL_PENDING_PREFIX);
  const match = candidates.find(({ key }) => key.endsWith(`-${id}.json`));
  if (!match) return null;
  const obj = await store.get(match.key);
  if (!obj) return null;
  try {
    return { key: match.key, proposal: JSON.parse(await obj.text()) };
  } catch {
    return null;
  }
}

async function toolProposeNote(store, scope, pathArg, content, reason, agent) {
  const path = normalizePath(pathArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (typeof content !== "string") return toolError("content must be a string");
  if (typeof reason !== "string" || !reason.trim()) return toolError("reason is required");
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > PROPOSAL_CONTENT_BYTE_CAP) {
    return toolError(`proposal content exceeds ${PROPOSAL_CONTENT_BYTE_CAP} bytes`);
  }
  const pending = await listAllKeys(store, PROPOSAL_PENDING_PREFIX);
  if (pending.length >= PROPOSAL_PENDING_CAP) {
    return toolError(`proposal queue is full (${PROPOSAL_PENDING_CAP}); ask a private connection to review it`);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const proposal = {
    id,
    intended_path: path,
    content,
    reason: reason.trim().slice(0, 2000),
    submitted_by: typeof agent === "string" && agent.trim() ? agent.trim().slice(0, 120) : "unspecified agent",
    submitted_scope: scope,
    created_at: createdAt,
    content_bytes: byteLength,
  };
  const key = `${PROPOSAL_PENDING_PREFIX}${timestampSlug(new Date(createdAt))}-${id}.json`;
  await store.put(key, JSON.stringify(proposal));
  await recordChange(store, "propose_note", scope, [path], {
    proposal_id: id,
    content_bytes: byteLength,
    team_visible: false,
  });
  return toolText(
    `proposal queued: ${id}\nintended path: ${path}\n` +
      "A private connection must review it. No note has been created or overwritten."
  );
}

async function toolListProposals(store, scope) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const keys = (await listAllKeys(store, PROPOSAL_PENDING_PREFIX)).sort((a, b) => a.key.localeCompare(b.key));
  if (!keys.length) return toolText("(no pending proposals)");
  const lines = [];
  for (const { key } of keys) {
    const obj = await store.get(key);
    if (!obj) continue;
    try {
      const proposal = JSON.parse(await obj.text());
      lines.push(
        `${proposal.id} — ${proposal.intended_path} — ${proposal.submitted_by} — ` +
          `${proposal.created_at} — ${proposal.content_bytes} bytes\n  reason: ${proposal.reason}`
      );
    } catch {
      continue;
    }
  }
  return toolText(lines.length ? lines.join("\n") : "(no readable pending proposals)");
}

async function toolReadProposal(store, scope, id) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { proposal } = found;
  return toolText(
    `proposal: ${proposal.id}\nintended path: ${proposal.intended_path}\n` +
      `submitted by: ${proposal.submitted_by}\ncreated: ${proposal.created_at}\n` +
      `reason: ${proposal.reason}\n\n${proposal.content}`
  );
}

async function toolReviewProposal(store, scope, id, action, destinationArg, reviewNote) {
  if (scope !== "private") {
    return toolError("permission denied: only a private connection can review proposals");
  }
  if (!["approve", "reject"].includes(action)) return toolError("action must be approve or reject");
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { key, proposal } = found;
  const reviewedAt = new Date().toISOString();
  let destination = null;

  if (action === "approve") {
    destination = normalizePath(destinationArg || proposal.intended_path);
    if (!destination || !destination.endsWith(".md")) {
      return toolError("invalid approval destination (must end in .md)");
    }
    if (isPlumbing(destination)) return toolError("that path is reserved");
    if (await store.get(destination)) {
      return toolError("conflict: approval destination already exists; choose a new destination or reject the proposal");
    }
    // Proposal approval is a personal review action and defaults private even
    // when the logical destination sits in a team-default folder.
    await persistExactVisibility(store, destination, "private", await loadScopeRules(store));
    await store.put(destination, proposal.content);
  }

  const reviewed = {
    ...proposal,
    status: action === "approve" ? "approved" : "rejected",
    reviewed_at: reviewedAt,
    final_path: destination,
    review_note: typeof reviewNote === "string" ? reviewNote.trim().slice(0, 2000) : "",
  };
  const reviewedKey =
    `${PROPOSAL_REVIEWED_PREFIX}${action === "approve" ? "approved" : "rejected"}/` +
    `${timestampSlug(new Date(reviewedAt))}-${proposal.id}.json`;
  await store.put(reviewedKey, JSON.stringify(reviewed));
  await store.delete(key);
  await recordChange(
    store,
    action === "approve" ? "approve_proposal" : "reject_proposal",
    scope,
    [destination || proposal.intended_path],
    { proposal_id: proposal.id, team_visible: false }
  );
  return toolText(
    action === "approve"
      ? `proposal approved: ${proposal.id}\ncreated: ${destination}\nvisibility: private`
      : `proposal rejected: ${proposal.id}\nintended path: ${proposal.intended_path}`
  );
}

async function toolSearchNotes(store, scope, rules, overrides, query, prefixArg) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const needle = query.toLowerCase();
  const listed = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  const keys = listed.filter(
    ({ key }) => key.endsWith(".md") && canSee(key, scope, rules, overrides)
  );
  const scanned = keys.slice(0, SEARCH_FILE_CAP);
  const hits = [];
  for (let start = 0; start < scanned.length && hits.length < 25; start += 32) {
    const batch = scanned.slice(start, start + 32);
    const matches = await mapInBatches(batch, 32, async ({ key }) => {
      const obj = await store.get(key);
      if (!obj) return null;
      const text = await obj.text();
      if (!text.toLowerCase().includes(needle)) return null;
      const snippets = text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .slice(0, 3)
        .map((line) => `    ${line.trim().slice(0, 200)}`);
      return `${key}\n${snippets.join("\n")}`;
    });
    for (const match of matches) {
      if (match) hits.push(match);
      if (hits.length >= 25) break;
    }
  }
  let out = hits.length ? hits.join("\n\n") : "(no matches)";
  if (keys.length > scanned.length) {
    out += `\n\n[note: scanned ${scanned.length} of ${keys.length} notes — narrow with a prefix if needed]`;
  }
  return toolText(out);
}

async function toolArchiveNote(store, scope, rules, overrides, pathArg, expectedEtag) {
  const path = normalizePath(pathArg);
  if (!path) return toolError("invalid path");
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");
  if (path.startsWith("4-archive/")) return toolText("already archived");
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  if (scope !== "private" && !expectedEtag) {
    return toolError("expected_etag is required when a team connection archives a note; read the note and retry");
  }
  if (expectedEtag && obj.etag !== expectedEtag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${obj.etag}); re-read and retry`
    );
  }
  const stamp = timestampSlug();
  const dest = `4-archive/${stamp}/${path}`;
  const destinationVisibility = scope === "private" ? "private" : "team";
  if (scope !== "private" && visibilityOf(dest, rules) !== "team") {
    return writePermissionError("archive destination");
  }
  if (await store.get(dest)) return toolError("conflict: archive destination already exists");
  const body = await obj.arrayBuffer();
  await store.put(`${HISTORY_PREFIX}${path}.${stamp}.archive.md`, body);
  if (destinationVisibility === "private") {
    await persistExactVisibility(store, dest, "private", rules);
  }
  await store.put(dest, body);
  if (destinationVisibility === "team") {
    await persistExactVisibility(store, dest, "team", rules);
  }
  await store.delete(path);
  await clearExactVisibility(store, path);
  await recordChange(store, "archive_note", scope, [path, dest], {
    visibility: destinationVisibility,
    team_visible: destinationVisibility === "team",
  });
  return toolText(`archived: ${path} → ${dest}\nvisibility: ${destinationVisibility}`);
}

async function toolMoveNote(store, scope, rules, overrides, sourceArg, destinationArg, expectedSourceEtag) {
  const source = normalizePath(sourceArg);
  const destination = normalizePath(destinationArg);
  if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
    return toolError("invalid path (source and destination must end in .md)");
  }
  if (source === destination) return toolText("source and destination are the same");
  if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
  if (!canSee(source, scope, rules, overrides)) return toolError("not found");
  if (scope !== "private" && visibilityOf(destination, rules) !== "team") {
    return writePermissionError("move destination");
  }
  if (scope === "team" && overrides.has(destination)) {
    return writePermissionError("move destination");
  }

  const sourceObject = await store.get(source);
  if (!sourceObject) return toolError("not found");
  if (expectedSourceEtag && sourceObject.etag !== expectedSourceEtag) {
    return toolError(
      `conflict: source changed since you read it (current etag ${sourceObject.etag}); re-read and retry`
    );
  }
  if (await store.get(destination)) return toolError("conflict: destination already exists");

  const body = await sourceObject.arrayBuffer();
  const sourceVisibility = effectiveVisibility(source, rules, overrides);
  const destinationVisibility =
    sourceVisibility === "private" || visibilityOf(destination, rules) === "private"
      ? "private"
      : "team";
  const stamp = timestampSlug();
  await store.put(`${HISTORY_PREFIX}${source}.${stamp}.move.md`, body);
  if (destinationVisibility === "private") {
    await persistExactVisibility(store, destination, "private", rules);
  }
  const put = await store.put(destination, body);
  if (destinationVisibility === "team") {
    await persistExactVisibility(store, destination, "team", rules);
  }
  await store.delete(source);
  await clearExactVisibility(store, source);
  await recordChange(store, "move_note", scope, [source, destination], {
    etag: put.etag,
    visibility: destinationVisibility,
    team_visible: sourceVisibility === "team" && destinationVisibility === "team",
  });
  return toolText(
    `moved: ${source} → ${destination} (etag ${put.etag})\nvisibility: ${destinationVisibility}`
  );
}

async function toolMoveNotes(store, scope, rules, overrides, movesArg, dryRun) {
  if (!Array.isArray(movesArg) || movesArg.length < 1) return toolError("moves must be a non-empty array");
  if (movesArg.length > BATCH_MOVE_CAP) {
    return toolError(`batch has more than ${BATCH_MOVE_CAP} moves; split it into smaller batches`);
  }

  const moves = [];
  for (const raw of movesArg) {
    const source = normalizePath(raw?.source);
    const destination = normalizePath(raw?.destination);
    if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
      return toolError("invalid path (every source and destination must end in .md)");
    }
    if (source === destination) return toolError(`source and destination are the same: ${source}`);
    if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
    moves.push({ source, destination, expectedSourceEtag: raw.expected_source_etag });
  }

  const sources = new Set(moves.map((move) => move.source));
  const destinations = new Set(moves.map((move) => move.destination));
  if (sources.size !== moves.length) return toolError("batch contains a duplicate source");
  if (destinations.size !== moves.length) return toolError("batch contains a duplicate destination");
  if (moves.some((move) => sources.has(move.destination))) {
    return toolError("batch destinations cannot also be batch sources; split cycles or chains into separate moves");
  }
  if (!dryRun && moves.some((move) => !move.expectedSourceEtag)) {
    return toolError(
      "expected_source_etag is required for every applied batch move. Run with dry_run=true to obtain current etags."
    );
  }

  const preflight = [];
  for (const move of moves) {
    if (!canSee(move.source, scope, rules, overrides)) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && overrides.has(move.destination)) {
      return writePermissionError("move destination");
    }
    const sourceObject = await store.get(move.source);
    if (!sourceObject) return toolError(`not found: ${move.source}`);
    if (move.expectedSourceEtag && sourceObject.etag !== move.expectedSourceEtag) {
      return toolError(
        `conflict: ${move.source} changed since it was read (current etag ${sourceObject.etag})`
      );
    }
    const sourceVisibility = effectiveVisibility(move.source, rules, overrides);
    const destinationFolderVisibility = visibilityOf(move.destination, rules);
    const destinationVisibility =
      sourceVisibility === "private" || destinationFolderVisibility === "private"
        ? "private"
        : "team";
    const fastArchiveCandidate =
      move.source.startsWith("4-archive/") &&
      move.destination.startsWith("4-archive/") &&
      !overrides.has(move.source) &&
      sourceVisibility === destinationFolderVisibility;
    const destinationObject = await store.get(move.destination);
    let preloadedBody = null;
    if (destinationObject) {
      const [sourceText, destinationText] = await Promise.all([
        sourceObject.text(),
        destinationObject.text(),
      ]);
      if (destinationText !== sourceText) {
        return toolError(`conflict: destination already exists with different content: ${move.destination}`);
      }
      if (fastArchiveCandidate) preloadedBody = sourceText;
    } else if (fastArchiveCandidate) {
      preloadedBody = await sourceObject.arrayBuffer();
    }
    preflight.push({
      ...move,
      etag: sourceObject.etag,
      visibility: destinationVisibility,
      destinationExists: Boolean(destinationObject),
      fastArchiveCandidate,
      body: preloadedBody,
    });
  }

  const planText = preflight
    .map(
      (move) =>
        `- ${move.source} (etag ${move.etag}) → ${move.destination} [${move.visibility}]`
    )
    .join("\n");
  if (dryRun) return toolText(`preflight ok: ${preflight.length} moves\n${planText}`);

  const fastArchiveRelocation = preflight.every((move) => move.fastArchiveCandidate);
  if (!fastArchiveRelocation) {
    for (const move of preflight) {
      const sourceObject = await store.get(move.source);
      if (!sourceObject || sourceObject.etag !== move.etag) {
        return toolError(`conflict: source changed during batch preflight: ${move.source}`);
      }
      move.body = await sourceObject.arrayBuffer();
    }
  }

  const stamp = timestampSlug();
  if (!fastArchiveRelocation) {
    try {
      for (const move of preflight) {
        await store.put(`${HISTORY_PREFIX}${move.source}.${stamp}.batch-move.md`, move.body);
      }
    } catch (error) {
      return toolError(`batch move aborted before copying destinations: history snapshot failed: ${error.message}`);
    }
  }

  const copied = [];
  const preparedAcls = [];
  try {
    for (const move of preflight) {
      if (!fastArchiveRelocation && move.visibility === "private") {
        await persistExactVisibility(store, move.destination, "private", rules);
        preparedAcls.push(move.destination);
      }
      if (!move.destinationExists) await store.put(move.destination, move.body);
      if (!fastArchiveRelocation && move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
      }
      if (!move.destinationExists) copied.push(move.destination);
    }
  } catch (error) {
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    for (const key of preparedAcls) await clearExactVisibility(store, key).catch(() => {});
    return toolError(`batch move aborted before deleting sources: ${error.message}`);
  }

  try {
    for (const move of preflight) await store.delete(move.source);
  } catch (error) {
    for (const move of preflight) await store.put(move.source, move.body).catch(() => {});
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    return toolError(`batch move rolled back after a source-delete failure: ${error.message}`);
  }

  if (!fastArchiveRelocation) {
    for (const move of preflight) await clearExactVisibility(store, move.source).catch(() => {});
  }

  await recordChange(
    store,
    "move_notes",
    scope,
    preflight.flatMap((move) => [move.source, move.destination]),
    {
      count: preflight.length,
      history_snapshot: !fastArchiveRelocation,
      visibilities: preflight.map((move) => ({ path: move.destination, visibility: move.visibility })),
      team_visible: preflight.every((move) => move.visibility === "team"),
    }
  );
  return toolText(`moved notes: ${preflight.length}\n${planText}`);
}

async function toolMoveFolder(store, scope, rules, overrides, sourceArg, destinationArg, dryRun) {
  const source = normalizePath(sourceArg)?.replace(/\/+$/, "");
  const destination = normalizePath(destinationArg)?.replace(/\/+$/, "");
  if (!source || !destination) return toolError("invalid folder path");
  if (source === destination) return toolText("source and destination are the same");
  if (
    isPlumbing(source) ||
    isPlumbing(destination) ||
    source.startsWith(destination + "/") ||
    destination.startsWith(source + "/")
  ) {
    return toolError("source and destination folders must be separate, non-reserved trees");
  }

  const sourcePrefix = `${source}/`;
  const destinationPrefix = `${destination}/`;
  const allObjects = (await listAllKeys(store, sourcePrefix)).filter(({ key }) => !isPlumbing(key));
  if (!allObjects.length) return toolError("not found");
  if (allObjects.length > FOLDER_MOVE_CAP) {
    return toolError(`folder has more than ${FOLDER_MOVE_CAP} objects; split it into smaller moves`);
  }
  if (scope !== "private" && allObjects.some(({ key }) => !canSee(key, scope, rules, overrides))) {
    return toolError(
      "permission denied: the folder includes content this connection cannot access; no paths were changed"
    );
  }

  const moves = allObjects.map(({ key }) => {
    const destinationPath = destinationPrefix + key.slice(sourcePrefix.length);
    const sourceVisibility = effectiveVisibility(key, rules, overrides);
    const destinationVisibility =
      sourceVisibility === "private" || visibilityOf(destinationPath, rules) === "private"
        ? "private"
        : "team";
    return { source: key, destination: destinationPath, visibility: destinationVisibility };
  });
  if (
    scope !== "private" &&
    moves.some(({ destination: path }) => visibilityOf(path, rules) !== "team")
  ) {
    return writePermissionError("folder move destination");
  }
  if (scope === "team" && moves.some(({ destination: path }) => overrides.has(path))) {
    return writePermissionError("folder move destination");
  }
  for (const move of moves) {
    if (await store.get(move.destination)) {
      return toolError(`conflict: destination already exists: ${move.destination}`);
    }
  }

  if (dryRun) {
    return toolText(
      `preflight ok: folder ${source}/ → ${destination}/ (${moves.length} objects)\n` +
        moves
          .map((move) => `- ${move.source} → ${move.destination} [${move.visibility}]`)
          .join("\n")
    );
  }

  const copied = [];
  const preparedAcls = [];
  const sourceBodies = [];
  try {
    for (const move of moves) {
      const obj = await store.get(move.source);
      if (!obj) throw new Error(`source changed during move: ${move.source}`);
      const body = await obj.arrayBuffer();
      sourceBodies.push({ ...move, body });
      if (move.visibility === "private") {
        await persistExactVisibility(store, move.destination, "private", rules);
        preparedAcls.push(move.destination);
      }
      await store.put(move.destination, body);
      if (move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
      }
      copied.push(move.destination);
    }
  } catch (error) {
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    for (const key of preparedAcls) await clearExactVisibility(store, key).catch(() => {});
    return toolError(`move aborted before deleting sources: ${error.message}`);
  }

  const stamp = timestampSlug();
  for (const item of sourceBodies) {
    await store.put(`${HISTORY_PREFIX}${item.source}.${stamp}.move.md`, item.body);
  }
  for (const { source: path } of moves) await store.delete(path);
  for (const { source: path } of moves) await clearExactVisibility(store, path).catch(() => {});
  await recordChange(store, "move_folder", scope, [source, destination], {
    count: moves.length,
    visibilities: moves.map((move) => ({ path: move.destination, visibility: move.visibility })),
    team_visible: moves.every((move) => move.visibility === "team"),
  });
  return toolText(`moved folder: ${source}/ → ${destination}/ (${moves.length} objects)`);
}

/* -------------------------------- inbox ---------------------------------- */

async function handleInbox(request, env, store, pathToken) {
  const token = pathToken || bearerToken(request);
  const ok =
    timingSafeEqual(token, env.INBOX_TOKEN) ||
    timingSafeEqual(token, env.PRIVATE_TOKEN);
  if (!ok) return json({ error: "unauthorized" }, 401);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }

  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }
  const raw = new TextDecoder().decode(rawBytes);

  let capture = { title: "capture", text: "", source: "inbox" };
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_json" }, 400);
    }
    capture = {
      title: body.title || "capture",
      text: body.text ?? body.content ?? body.notes ?? "",
      source: body.source || "inbox",
      externalId: body.external_id ?? body.id ?? "",
      sourceUrl: body.source_url ?? body.url ?? "",
      sourceCreatedAt: body.source_created_at ?? body.created_at ?? "",
      attendees: body.attendees,
      metadata: body.metadata ?? null,
    };
  } else {
    capture.text = raw;
  }
  if (!String(capture.text).trim()) return json({ error: "empty" }, 400);

  const actorScope = timingSafeEqual(token, env.PRIVATE_TOKEN) ? "private" : "inbox";
  const result = await writeInboxCapture(store, capture, { actorScope });
  return json({ ok: true, ...result });
}

async function writeInboxCapture(store, capture, { actorScope = "inbox", replaceExisting = false } = {}) {
  const now = new Date();
  const title = singleLine(capture.title || "capture");
  const text = String(capture.text ?? "");
  const source = singleLine(capture.source || "inbox");
  const externalId = singleLine(capture.externalId || "");
  const sourceUrl = singleLine(capture.sourceUrl || "");
  const sourceCreatedAt = singleLine(capture.sourceCreatedAt || "");
  const attendees = normalizeInboxAttendees(capture.attendees);
  const metadata = capture.metadata ?? null;
  const sourceSlug = safeSlug(source, 30);
  let key;
  if (externalId) {
    const fingerprint = await sha256Hex(`${source}\0${externalId}`);
    key = `0-inbox/${sourceSlug}/${fingerprint.slice(0, 24)}.md`;
  } else {
    const titleSlug = safeSlug(title, 40);
    key = `0-inbox/${now.toISOString().slice(0, 19).replace(/[:]/g, "-")}-${titleSlug}.md`;
  }

  const existing = await store.get(key);
  if (existing && !replaceExisting) return { path: key, duplicate: true };

  const frontmatter = [
    "---",
    `captured: ${JSON.stringify(now.toISOString())}`,
    `source: ${JSON.stringify(source)}`,
    "status: unprocessed",
  ];
  if (externalId) frontmatter.push(`external-id: ${JSON.stringify(externalId)}`);
  if (sourceCreatedAt) frontmatter.push(`source-created-at: ${JSON.stringify(sourceCreatedAt)}`);
  if (sourceUrl) frontmatter.push(`source-url: ${JSON.stringify(sourceUrl)}`);
  frontmatter.push("---");

  const bodyParts = [`# ${title}`, ""];
  if (sourceUrl) bodyParts.push(`Source: <${sourceUrl}>`, "");
  if (attendees.length) {
    bodyParts.push("## Attendees", "", ...attendees.map((attendee) => `- ${attendee}`), "");
  }
  bodyParts.push(text.trim(), "");
  if (metadata !== null && metadata !== "") {
    const metadataText =
      typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2);
    bodyParts.push("## Capture metadata", "", "```json", metadataText, "```", "");
  }

  const note = `${frontmatter.join("\n")}\n\n${bodyParts.join("\n")}`;
  if (existing) {
    const previous = await existing.text();
    if (previous === note) return { path: key, duplicate: true };
    await store.put(`${HISTORY_PREFIX}${key}.${timestampSlug()}.inbox.md`, previous);
  }
  await store.put(key, note);
  await recordChange(store, existing ? "inbox_update" : "inbox_capture", actorScope, [key], { source });
  return { path: key, duplicate: false, updated: Boolean(existing) };
}

function singleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function safeSlug(value, maxLength) {
  return singleLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength) || "capture";
}

function normalizeInboxAttendees(value) {
  if (Array.isArray(value)) {
    return value.map(formatInboxAttendee).filter(Boolean).slice(0, 200);
  }
  if (typeof value === "string") {
    return value.split(/[\n,;]+/).map(singleLine).filter(Boolean).slice(0, 200);
  }
  return [];
}

function formatInboxAttendee(value) {
  if (value && typeof value === "object") {
    const name = singleLine(value.name || "");
    const email = singleLine(value.email || "");
    if (name && email) return `${name} <${email}>`;
    return name || email;
  }
  return singleLine(value);
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* --------------------------- Granola webhooks ---------------------------- */

async function handleGranolaWebhook(request, env, store, ctx) {
  if (!env.GRANOLA_WEBHOOK_SECRET) return json({ error: "not_configured" }, 503);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const raw = new TextDecoder().decode(rawBytes);

  const signatureOk = await verifyGranolaSignature(request.headers, raw, env.GRANOLA_WEBHOOK_SECRET);
  if (!signatureOk) return json({ error: "invalid_signature" }, 401);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const eventId = singleLine(event?.event_id || "");
  const eventType = singleLine(event?.event_type || "");
  const noteId = singleLine(event?.note_id || "");
  if (
    !eventId ||
    !/^not_[a-zA-Z0-9]{14}$/.test(noteId) ||
    !["note.generated", "note.edited", "note.access_granted"].includes(eventType)
  ) {
    return json({ error: "invalid_event" }, 400);
  }

  const completedKey = `${GRANOLA_COMPLETED_PREFIX}${safeSlug(eventId, 80)}.json`;
  if (await store.get(completedKey)) return json({ ok: true, duplicate: true });

  const pendingKey = `${GRANOLA_PENDING_PREFIX}${safeSlug(eventId, 80)}.json`;
  await store.put(pendingKey, JSON.stringify({ ...event, received_at: new Date().toISOString() }));
  const work = processGranolaEventSafely(env, store, pendingKey);
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return json({ ok: true, accepted: true }, 202);
}

async function verifyGranolaSignature(headers, rawBody, signingSecret) {
  if (!signingSecret.startsWith("whsec_")) return false;
  const webhookId = headers.get("webhook-id") || "";
  const timestampText = headers.get("webhook-timestamp") || "";
  const signatureHeader = headers.get("webhook-signature") || "";
  const timestamp = Number(timestampText);
  if (!webhookId || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > GRANOLA_WEBHOOK_MAX_AGE_SECONDS) return false;

  let keyBytes;
  try {
    keyBytes = decodeBase64(signingSecret.slice("whsec_".length));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedContent = `${webhookId}.${timestampText}.${rawBody}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent))
  );
  const expected = encodeBase64(signature);
  return signatureHeader.split(/\s+/).some((candidate) => {
    const [version, provided = ""] = candidate.split(",");
    return version === "v1" && timingSafeEqual(provided, expected);
  });
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function processGranolaEventSafely(env, store, pendingKey) {
  try {
    await processGranolaEvent(env, store, pendingKey);
  } catch (error) {
    const pending = await store.get(pendingKey);
    if (!pending) return;
    let event = {};
    try {
      event = JSON.parse(await pending.text());
    } catch {}
    await store.put(
      pendingKey,
      JSON.stringify({
        ...event,
        attempts: Number(event.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: singleLine(error?.message || "Granola sync failed").slice(0, 300),
      })
    );
  }
}

async function processGranolaEvent(env, store, pendingKey) {
  if (!env.GRANOLA_API_KEY) throw new Error("GRANOLA_API_KEY is not configured");
  const pending = await store.get(pendingKey);
  if (!pending) return;
  const event = JSON.parse(await pending.text());
  const response = await fetch(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(event.note_id)}`, {
    headers: { Authorization: `Bearer ${env.GRANOLA_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Granola Get Note returned ${response.status}`);
  const note = await response.json();
  const text = note.summary_markdown || note.summary_text || "";
  if (!String(text).trim()) throw new Error("Granola note has no generated summary yet");

  await writeInboxCapture(
    store,
    {
      title: note.title || "Granola meeting",
      text,
      source: "granola",
      externalId: note.id || event.note_id,
      sourceUrl: note.web_url || "",
      sourceCreatedAt: note.created_at || event.occurred_at || "",
      attendees: note.attendees || [],
      metadata: {
        event_type: event.event_type,
        event_id: event.event_id,
        updated_at: note.updated_at || null,
        owner: note.owner || null,
        calendar_event: note.calendar_event || null,
        folders: note.folder_membership || [],
      },
    },
    { actorScope: "granola", replaceExisting: true }
  );

  const eventSlug = safeSlug(event.event_id, 80);
  await store.put(
    `${GRANOLA_COMPLETED_PREFIX}${eventSlug}.json`,
    JSON.stringify({ event_id: event.event_id, note_id: event.note_id, completed_at: new Date().toISOString() })
  );
  await store.delete(pendingKey);
}

async function processPendingGranolaEvents(env, store) {
  if (!env.GRANOLA_API_KEY) return;
  const pending = (await listAllKeys(store, GRANOLA_PENDING_PREFIX)).slice(0, 100);
  await Promise.all(pending.map(({ key }) => processGranolaEventSafely(env, store, key)));
}

/* ------------------------------- calendar --------------------------------- */

async function syncCalendar(env, store) {
  if (!env.CALENDAR_ICS_URL) return;
  const res = await fetch(env.CALENDAR_ICS_URL);
  if (!res.ok) return;
  const ics = await res.text();
  const now = Date.now();
  const horizon = now + 14 * 24 * 3600 * 1000;
  const events = expandCalendarEvents(
    parseIcs(ics),
    new Date(now - 24 * 3600 * 1000),
    new Date(horizon)
  );
  const upcoming = events
    .filter((e) => e.start && e.start.getTime() >= now - 24 * 3600 * 1000 && e.start.getTime() <= horizon)
    .sort((a, b) => a.start - b.start);

  const byDay = new Map();
  for (const e of upcoming) {
    const day = e.start.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  let md = `---\nupdated: ${new Date().toISOString()}\nsource: calendar-cron\n---\n\n# Calendar — next 14 days\n\n`;
  md += `> Auto-generated from the calendar feed. Times are UTC unless the event was all-day.\n> Common recurring-event rules are expanded; unusually complex rules may be under-represented.\n\n`;
  if (!byDay.size) md += "_No events in the next 14 days._\n";
  for (const [day, list] of byDay) {
    md += `## ${day}\n`;
    for (const e of list) {
      const time = e.allDay ? "all day" : e.start.toISOString().slice(11, 16);
      md += `- ${time} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}\n`;
    }
    md += "\n";
  }
  await store.put("2-areas/calendar/next-14-days.md", md);
  await recordChange(store, "calendar_sync", "system", ["2-areas/calendar/next-14-days.md"], {
    count: upcoming.length,
  });
}

function parseIcs(ics) {
  // Unfold continuation lines (RFC 5545 §3.1)
  const lines = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const nameAndParams = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const name = nameAndParams.split(";")[0];
      if (name === "SUMMARY") cur.summary = unescapeIcs(value);
      else if (name === "LOCATION") cur.location = unescapeIcs(value);
      else if (name === "UID") cur.uid = value;
      else if (name === "STATUS") cur.status = value;
      else if (name === "RRULE") cur.rrule = value;
      else if (name === "RECURRENCE-ID") cur.recurrenceId = parseIcsDate(value);
      else if (name === "EXDATE") {
        cur.exdates ||= [];
        cur.exdates.push(...value.split(",").map(parseIcsDate).filter(Boolean));
      } else if (name === "RDATE") {
        cur.rdates ||= [];
        cur.rdates.push(...value.split(",").map((v) => parseIcsDate(v.split("/")[0])).filter(Boolean));
      }
      else if (name === "DTSTART") {
        cur.allDay = nameAndParams.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        cur.start = parseIcsDate(value);
      }
    }
  }
  return events;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function expandCalendarEvents(events, windowStart, windowEnd) {
  const exceptions = new Map();
  for (const event of events) {
    if (!event.uid || !event.recurrenceId) continue;
    if (!exceptions.has(event.uid)) exceptions.set(event.uid, new Map());
    exceptions.get(event.uid).set(event.recurrenceId.getTime(), event);
  }

  const usedExceptions = new Set();
  const expanded = [];
  for (const event of events) {
    if (!event.start || event.recurrenceId || event.status === "CANCELLED") continue;
    const starts = event.rrule
      ? expandRecurrenceStarts(event, windowStart, windowEnd)
      : [event.start];
    for (const rdate of event.rdates || []) starts.push(rdate);

    const seenStarts = new Set();
    for (const recurrenceStart of starts.sort((a, b) => a - b)) {
      const recurrenceTime = recurrenceStart.getTime();
      if (seenStarts.has(recurrenceTime)) continue;
      seenStarts.add(recurrenceTime);
      if ((event.exdates || []).some((date) => date.getTime() === recurrenceTime)) continue;

      const exception = event.uid ? exceptions.get(event.uid)?.get(recurrenceTime) : null;
      if (exception) usedExceptions.add(exception);
      if (exception?.status === "CANCELLED") continue;

      const actualStart = exception?.start || recurrenceStart;
      if (actualStart < windowStart || actualStart > windowEnd) continue;
      expanded.push({
        ...event,
        ...exception,
        start: actualStart,
        summary: exception?.summary ?? event.summary,
        location: exception?.location ?? event.location,
        allDay: exception?.allDay ?? event.allDay,
        rrule: undefined,
        recurrenceId: undefined,
      });
    }
  }

  // A moved exception can land inside the window even when its original
  // occurrence is outside it, so include any such unconsumed exception.
  for (const event of events) {
    if (
      event.recurrenceId &&
      !usedExceptions.has(event) &&
      event.status !== "CANCELLED" &&
      event.start &&
      event.start >= windowStart &&
      event.start <= windowEnd
    ) {
      expanded.push({ ...event, recurrenceId: undefined });
    }
  }

  return expanded;
}

function expandRecurrenceStarts(event, windowStart, windowEnd) {
  const rule = parseRrule(event.rrule);
  if (!rule || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) {
    return [event.start];
  }

  const start = event.start;
  const until = rule.until || windowEnd;
  const scanEnd = until < windowEnd ? until : windowEnd;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastDay = new Date(Date.UTC(scanEnd.getUTCFullYear(), scanEnd.getUTCMonth(), scanEnd.getUTCDate()));
  const matches = [];

  while (cursor <= lastDay) {
    const candidate = new Date(Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds()
    ));
    if (candidate >= start && candidate <= until && matchesRecurrenceDate(candidate, start, rule)) {
      matches.push(candidate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const positioned = applyBySetPos(matches, rule);
  const counted = rule.count ? positioned.slice(0, rule.count) : positioned;
  return counted.filter((date) => date >= windowStart && date <= windowEnd);
}

function parseRrule(text) {
  if (!text) return null;
  const values = {};
  for (const part of text.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) values[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (!values.FREQ) return null;
  const until = values.UNTIL ? parseIcsDate(values.UNTIL) : null;
  if (until && /^\d{8}$/.test(values.UNTIL)) until.setUTCHours(23, 59, 59, 999);
  const weekStart = WEEKDAYS.indexOf(values.WKST || "MO");
  return {
    freq: values.FREQ,
    interval: Math.max(1, Number.parseInt(values.INTERVAL || "1", 10) || 1),
    count: Math.max(0, Number.parseInt(values.COUNT || "0", 10) || 0),
    until,
    byday: parseByDay(values.BYDAY),
    bymonthday: parseNumberList(values.BYMONTHDAY),
    bymonth: parseNumberList(values.BYMONTH),
    bysetpos: parseNumberList(values.BYSETPOS),
    wkst: weekStart < 0 ? 1 : weekStart,
  };
}

function parseNumberList(value) {
  if (!value) return [];
  return value.split(",").map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

function parseByDay(value) {
  if (!value) return [];
  return value.split(",").map((item) => {
    const match = item.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    return match
      ? { ordinal: Number.parseInt(match[1] || "0", 10), weekday: WEEKDAYS.indexOf(match[2]) }
      : null;
  }).filter(Boolean);
}

function matchesRecurrenceDate(candidate, start, rule) {
  const dayMs = 24 * 3600 * 1000;
  const dayDiff = Math.floor((startOfUtcDay(candidate) - startOfUtcDay(start)) / dayMs);
  const monthDiff =
    (candidate.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    candidate.getUTCMonth() - start.getUTCMonth();
  const yearDiff = candidate.getUTCFullYear() - start.getUTCFullYear();

  if (rule.bymonth.length && !rule.bymonth.includes(candidate.getUTCMonth() + 1)) return false;
  if (rule.bymonthday.length && !matchesMonthDay(candidate, rule.bymonthday)) return false;
  if (rule.byday.length && !matchesByDay(candidate, rule.byday, rule.freq, rule.bymonth.length > 0)) return false;

  if (rule.freq === "DAILY") return dayDiff % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const weekDiff = Math.floor(
      (startOfWeek(candidate, rule.wkst) - startOfWeek(start, rule.wkst)) / (7 * dayMs)
    );
    const allowedDays = rule.byday.length
      ? rule.byday.map((item) => item.weekday)
      : [start.getUTCDay()];
    return weekDiff % rule.interval === 0 && allowedDays.includes(candidate.getUTCDay());
  }
  if (rule.freq === "MONTHLY") {
    if (monthDiff % rule.interval !== 0) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  if (rule.freq === "YEARLY") {
    if (yearDiff % rule.interval !== 0) return false;
    if (!rule.bymonth.length && candidate.getUTCMonth() !== start.getUTCMonth()) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  return false;
}

function matchesMonthDay(date, values) {
  const day = date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return values.some((value) => value > 0 ? day === value : day === daysInMonth + value + 1);
}

function matchesByDay(date, values, frequency, hasByMonth) {
  return values.some(({ ordinal, weekday }) => {
    if (date.getUTCDay() !== weekday) return false;
    if (!ordinal || frequency === "DAILY" || frequency === "WEEKLY") return true;
    if (frequency === "MONTHLY" || (frequency === "YEARLY" && hasByMonth)) {
      const ordinals = weekdayOrdinalsInMonth(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    if (frequency === "YEARLY") {
      const ordinals = weekdayOrdinalsInYear(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    return true;
  });
}

function weekdayOrdinalsInMonth(date) {
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    positive: Math.ceil(date.getUTCDate() / 7),
    negative: -Math.ceil((daysInMonth - date.getUTCDate() + 1) / 7),
  };
}

function weekdayOrdinalsInYear(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const nextYear = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  const dayOfYear = Math.floor((startOfUtcDay(date) - yearStart) / (24 * 3600 * 1000)) + 1;
  const daysInYear = Math.floor((nextYear - yearStart) / (24 * 3600 * 1000));
  return {
    positive: Math.ceil(dayOfYear / 7),
    negative: -Math.ceil((daysInYear - dayOfYear + 1) / 7),
  };
}

function applyBySetPos(matches, rule) {
  if (!rule.bysetpos.length) return matches;
  const groups = new Map();
  for (const date of matches) {
    const key = recurrencePeriodKey(date, rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  }
  const selected = [];
  for (const dates of groups.values()) {
    for (const position of rule.bysetpos) {
      const index = position > 0 ? position - 1 : dates.length + position;
      if (dates[index]) selected.push(dates[index]);
    }
  }
  return [...new Map(selected.map((date) => [date.getTime(), date])).values()].sort((a, b) => a - b);
}

function recurrencePeriodKey(date, rule) {
  if (rule.freq === "YEARLY") return `${date.getUTCFullYear()}`;
  if (rule.freq === "MONTHLY") return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  if (rule.freq === "WEEKLY") return `${startOfWeek(date, rule.wkst)}`;
  return `${startOfUtcDay(date)}`;
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfWeek(date, weekStart) {
  const dayStart = startOfUtcDay(date);
  const offset = (date.getUTCDay() - weekStart + 7) % 7;
  return dayStart - offset * 24 * 3600 * 1000;
}

function parseIcsDate(v) {
  let mm = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (mm) {
    // Treat non-UTC (TZID) timestamps as UTC — approximate but predictable.
    return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]));
  }
  mm = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (mm) return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3]));
  return null;
}

function unescapeIcs(s) {
  return s.replace(/\\n/g, " · ").replace(/\\([,;\\])/g, "$1");
}

/* -------------------------------- helpers --------------------------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcErrorObj(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcError(id, code, message) {
  return json(jsonRpcErrorObj(id, code, message));
}
