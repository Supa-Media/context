/**
 * Shared fixtures and the stub authorization server used across the hook's
 * test files. See `test.mjs` for what these checks are actually guarding.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";

export let failures = 0;
export function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

/* ------------------------- a stub authorization server ------------------- */

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startStubServer() {
  const state = {
    registered: [],
    codes: new Map(),
    refreshTokens: new Map(),
    captures: [],
    mcpCalls: [],
    orientFails: false,
    /** Every Authorization header the gateway half was shown. */
    seenTokens: [],
    rotate: true,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { "Content-Type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    };
    const origin = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/register") {
      const body = JSON.parse(await readBody());
      state.registered.push(body);
      return send(201, { client_id: `client_${state.registered.length}` });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await readBody());
      if (form.get("grant_type") === "refresh_token") {
        const record = state.refreshTokens.get(form.get("refresh_token"));
        if (!record) return send(400, { error: "invalid_grant" });
        state.refreshTokens.delete(form.get("refresh_token"));
        const next = `refresh_${state.refreshTokens.size + 2}`;
        state.refreshTokens.set(next, record);
        return send(200, {
          access_token: `access_${next}`,
          refresh_token: state.rotate ? next : form.get("refresh_token"),
          expires_in: 3600,
          scope: record.scope,
        });
      }
      const issued = state.codes.get(form.get("code"));
      if (!issued) return send(400, { error: "invalid_grant" });
      state.codes.delete(form.get("code"));
      // The real thing verifies the challenge; so does this, or the test would
      // pass for a client that sent no verifier at all.
      const presented = base64Url(createHash("sha256").update(form.get("code_verifier") || "").digest());
      if (presented !== issued.challenge) return send(400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== issued.redirectUri) return send(400, { error: "invalid_grant" });
      state.refreshTokens.set("refresh_1", { scope: issued.scope });
      return send(200, {
        access_token: "access_1",
        refresh_token: "refresh_1",
        expires_in: 3600,
        scope: issued.scope,
      });
    }
    if (url.pathname === "/mcp") {
      state.seenTokens.push(request.headers.authorization || "");
      const rpc = JSON.parse(await readBody());
      state.mcpCalls.push(rpc);
      if (state.orientFails) return send(500, { error: "boom" });
      return send(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: "# Orientation\n\n12 notes visible." }] },
      });
    }
    if (url.pathname === "/inbox") {
      state.seenTokens.push(request.headers.authorization || "");
      state.captures.push(JSON.parse(await readBody()));
      return send(200, { ok: true });
    }
    return send(404, { error: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** Stand in for the person and their browser. */
  state.approve = async (href) => {
    const url = new URL(href);
    const code = `code_${state.codes.size + 1}`;
    state.codes.set(code, {
      challenge: url.searchParams.get("code_challenge"),
      redirectUri: url.searchParams.get("redirect_uri"),
      scope: url.searchParams.get("scope"),
    });
    state.lastAuthorize = url;
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    await fetch(back.href);
  };

  return { origin, endpoint: `${origin}/mcp`, state, close: () => server.close() };
}

/* --------------------------------- fixtures ------------------------------ */

/**
 * A session log shaped like the real thing: a system line, a sidechain, a
 * thinking block, a tool call and its result, and two messages a person
 * actually saw. Every line but the last two is something that must not travel.
 */
export const SECRETS = {
  systemPrompt: "SYSTEM-PROMPT-DO-NOT-CAPTURE",
  thinking: "INTERNAL-REASONING-DO-NOT-CAPTURE",
  toolInput: "cat /home/someone/.aws/credentials",
  toolResult: "AKIA-FAKE-KEY-DO-NOT-CAPTURE",
  sidechain: "SUBAGENT-CHATTER-DO-NOT-CAPTURE",
  meta: "REPLAYED-META-LINE-DO-NOT-CAPTURE",
  injected: "HARNESS-INJECTED-TURN-DO-NOT-CAPTURE",
  compactSummary: "AUTO-COMPACTION-DIGEST-DO-NOT-CAPTURE",
  transcriptOnly: "TRANSCRIPT-ONLY-SYNTHETIC-DO-NOT-CAPTURE",
};

export const TRANSCRIPT = [
  { type: "system", content: SECRETS.systemPrompt },
  { type: "user", isMeta: true, message: { role: "user", content: SECRETS.meta } },
  { type: "user", message: { role: "user", content: "Rename the orient tool." } },
  // A turn the HARNESS wrote, not the person: role `user`, a plain `text`
  // block, and nothing in the content to distinguish it. Claude Code marks it
  // structurally instead — `origin.kind` — which is what makes this an
  // allow-list on a field rather than a denylist over prose. Observed shape,
  // not assumed: in a real 7,423-line session log, 90 of the 92 harness-written
  // user turns carried `{"kind":"task-notification"}` and every turn the person
  // typed carried `{"kind":"human"}` or no `origin` at all.
  {
    type: "user",
    origin: { kind: "task-notification" },
    message: { role: "user", content: SECRETS.injected },
  },
  // The harness's own compaction summary: a `user` role, a plain string, and
  // NO `origin` at all — so the kind check cannot see it. It condenses the
  // whole session, which is why it is the largest thing that can leave here.
  // In a real log the three of these ran to 58,410 characters and carried 17
  // references to security-review exploit detail plus the user's absolute
  // paths.
  // Compaction flag ONLY. The observed instances carried the display flag too,
  // but the harness's compaction path sometimes sets `summarizeMetadata`
  // instead — and more to the point, an entry carrying both proves neither
  // guard: whichever term is removed, the other still drops it.
  {
    type: "user",
    isCompactSummary: true,
    message: { role: "user", content: SECRETS.compactSummary },
  },
  // The display flag WITHOUT the compaction flag. They co-occur on every
  // instance measured so far, which is exactly why this entry exists: the two
  // are independent parameters, so a guard that only knew about compaction
  // would be one harness change away from the leak it was written to stop.
  {
    type: "user",
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: SECRETS.transcriptOnly },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: SECRETS.thinking },
        { type: "text", text: "I will rename it and update the tests." },
        { type: "tool_use", name: "Bash", input: { command: SECRETS.toolInput } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: SECRETS.toolResult }] }],
    },
  },
  {
    type: "assistant",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text: SECRETS.sidechain }] },
  },
  // The positive control for the `origin` guard, and it is not decoration:
  // every other assertion here is "this must NOT travel", so a guard tightened
  // to drop EVERY origin-marked turn — not just the harness's — would keep the
  // suite green while real messages silently stopped being captured. This is
  // the only entry that fails in that direction.
  {
    type: "user",
    origin: { kind: "human" },
    message: { role: "user", content: "And keep the tests honest." },
  },
  { type: "assistant", message: { role: "assistant", content: "Done — 484 checks pass." } },
  "{ this line is half written",
]
  .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
  .join("\n");
