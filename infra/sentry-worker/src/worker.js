/**
 * Signed Sentry webhook -> one short Markdown note in Context.
 *
 * This adapter holds a Context grant for a dedicated test identity. The Sentry
 * signature authorizes one fixed transformation; neither the request body nor
 * its URL can choose a context or folder. Raw events and stack traces are never
 * stored here.
 */

const MAX_BODY_BYTES = 256_000;
const MAX_FIELD_LENGTH = 280;
const ISSUE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const SHORT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("sentry_inbox_failed", error instanceof Error ? error.name : "unknown");
      return json({ error: "unavailable" }, 503);
    }
  },
};

/**
 * A single Durable Object owns the rotating OAuth grant. Context rotates a
 * refresh token every time it is used, so two concurrent refreshes with the
 * same token would correctly revoke the grant as a replay. Keeping refreshes
 * behind this one serialized broker prevents that race and makes the
 * integration durable beyond the one-hour access-token lifetime.
 */
export class ContextTokenBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshing = null;
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/token") return json({ error: "not_found" }, 404);
    try {
      const token = await this.accessToken();
      return json({ accessToken: token });
    } catch (error) {
      console.error("context_token_refresh_failed", error instanceof Error ? error.name : "unknown");
      return json({ error: "unavailable" }, 503);
    }
  }

  async accessToken() {
    const stored = await this.state.storage.get("oauth");
    if (stored?.accessToken && stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
    if (!this.refreshing) this.refreshing = this.refresh(stored).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refresh(stored) {
    const refreshToken = stored?.refreshToken || this.env.CONTEXT_MCP_REFRESH_TOKEN;
    const endpoint = new URL("/oauth/token", this.env.CONTEXT_MCP_ENDPOINT).toString();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.env.CONTEXT_MCP_CLIENT_ID,
      resource: this.env.CONTEXT_MCP_ENDPOINT,
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error("ContextTokenRefreshRejected");
    const result = await response.json();
    if (!field(result?.access_token) || !field(result?.refresh_token)) throw new Error("ContextTokenRefreshMalformed");
    const next = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
    };
    await this.state.storage.put("oauth", next);
    return next.accessToken;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/sentry") return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!configured(env)) return json({ error: "not_found" }, 404);

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "too_large" }, 413);
  }
  const rawBody = await readBodyUpTo(request, MAX_BODY_BYTES);
  if (rawBody === null) return json({ error: "too_large" }, 413);
  if (!(await signatureIsValid(
    rawBody,
    request.headers.get("Sentry-Hook-Signature"),
    env.SENTRY_WEBHOOK_CLIENT_SECRET
  ))) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const resource = (request.headers.get("Sentry-Hook-Resource") || "").toLowerCase();
  const incident = parseIncident(payload, resource);
  if (!incident || incident.project !== env.SENTRY_PROJECT_SLUG.trim().toLowerCase()) {
    return json({ accepted: true, ignored: true }, 202);
  }

  const path = incidentPath(env.SENTRY_INCIDENT_PREFIX, incident.shortId);
  const content = renderIncident(incident);
  const accessToken = await contextAccessToken(env);
  const response = await fetch(env.CONTEXT_MCP_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: incident.eventId || incident.issueId,
      method: "tools/call",
      params: {
        name: "write_note",
        arguments: {
          path,
          content,
          visibility: "team",
          // The destination was explicitly approved as a shared incident inbox.
          confirm_team_publish: true,
        },
      },
    }),
  });
  if (!response.ok) return json({ error: "unavailable" }, 503);
  let result;
  try {
    result = await response.json();
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (result?.error || result?.result?.isError) return json({ error: "unavailable" }, 503);
  return json({ accepted: true }, 202);
}

async function readBodyUpTo(request, maximum) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function configured(env) {
  return [
    env?.SENTRY_WEBHOOK_CLIENT_SECRET,
    env?.CONTEXT_MCP_REFRESH_TOKEN,
    env?.CONTEXT_MCP_CLIENT_ID,
    env?.CONTEXT_MCP_ENDPOINT,
    env?.SENTRY_PROJECT_SLUG,
    env?.SENTRY_INCIDENT_PREFIX,
  ].every((value) => typeof value === "string" && value.trim()) && env?.CONTEXT_TOKEN_BROKER;
}

async function contextAccessToken(env) {
  // A new OAuth client gets a fresh broker identity, so replacing a revoked
  // grant never reuses the previous client's persisted rotating token.
  const id = env.CONTEXT_TOKEN_BROKER.idFromName(env.CONTEXT_MCP_CLIENT_ID);
  const response = await env.CONTEXT_TOKEN_BROKER.get(id).fetch("https://context-token.internal/token");
  if (!response.ok) throw new Error("ContextTokenUnavailable");
  const result = await response.json();
  if (!field(result?.accessToken)) throw new Error("ContextTokenMalformed");
  return result.accessToken;
}

async function signatureIsValid(rawBody, signature, secret) {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(signature.toLowerCase(), expected);
}

function parseIncident(payload, resource) {
  if (!object(payload)) return null;
  const data = object(payload.data);
  const source = resource === "error" ? object(data?.error)
    : resource === "issue" ? object(data?.issue)
    : resource === "event_alert" ? object(data?.event)
    : object(payload.event);
  if (!source) return null;
  const issueId = field(source.issue_id ?? source.issueId ?? source.groupID ?? source.id);
  if (!ISSUE_ID_PATTERN.test(issueId)) return null;
  const shortCandidate = field(source.short_id ?? source.shortId ?? source.issue_short_id);
  const shortId = SHORT_ID_PATTERN.test(shortCandidate) ? shortCandidate : `SENTRY-${issueId}`;
  const metadata = object(source.metadata);
  return {
    issueId,
    eventId: field(source.event_id ?? source.eventID),
    shortId,
    project: field(object(source.project)?.slug ?? object(data?.project)?.slug ?? payload.project_slug ?? payload.project_name).toLowerCase(),
    type: safeText(metadata?.type ?? source.type ?? "Error", 80),
    value: safeText(metadata?.value ?? source.message ?? source.title ?? "An error occurred"),
    culprit: safeText(source.culprit ?? source.location ?? "", 180),
    environment: safeText(tagValue(source.tags, "environment"), 80),
    level: safeText(source.level ?? "error", 40).toLowerCase(),
    webUrl: safeSentryUrl(source.web_url ?? source.webUrl ?? payload.url),
  };
}

function renderIncident(incident, now = new Date()) {
  const core = incident.value.toLowerCase().startsWith(`${incident.type.toLowerCase()}:`)
    ? incident.value : `${incident.type}: ${incident.value}`;
  const sentence = `${core}${incident.culprit ? ` in ${incident.culprit}` : ""}.`;
  const lines = [
    "---",
    `updated: ${now.toISOString().slice(0, 10)}`,
    "source: sentry",
    "status: open",
    "visibility: team",
    `sentry-issue-id: ${JSON.stringify(incident.issueId)}`,
    `severity: ${JSON.stringify(incident.level)}`,
  ];
  if (incident.environment) lines.push(`environment: ${JSON.stringify(incident.environment)}`);
  lines.push("---", "", `# ${incident.shortId}: ${incident.type}`, "", `**What is happening:** ${sentence}`);
  if (incident.webUrl) lines.push("", `Sentry: <${incident.webUrl}>`);
  return `${lines.join("\n")}\n`;
}

function incidentPath(prefix, shortId) {
  const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  const slug = shortId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${cleanPrefix}/${slug}.md`;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function field(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
function tagValue(tags, wanted) {
  if (!Array.isArray(tags)) return "";
  return field(object(tags.find((tag) => object(tag)?.key === wanted))?.value);
}
function safeText(value, max = MAX_FIELD_LENGTH) {
  return redact(field(value)).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}
function redact(value) {
  return value
    .replace(/\b(?:bearer\s+)?[a-z0-9_-]*(?:token|secret|password|api[_-]?key)[a-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk)_[a-zA-Z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]");
}
function safeSentryUrl(value) {
  try {
    const url = new URL(field(value));
    if (url.protocol !== "https:" || !/(^|\.)sentry\.io$/i.test(url.hostname)) return "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}
function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
