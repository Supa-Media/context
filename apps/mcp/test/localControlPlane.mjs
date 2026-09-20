/**
 * A control plane over real HTTP, for verification in a real browser.
 *
 * `controlPlaneStub.mjs` answers the same contract by swapping `globalThis.fetch`,
 * which works inside the node suite and is invisible to a Worker running in
 * `wrangler dev` — that Worker makes real network calls from another process.
 * So this is the same contract served over a socket, and it exists for exactly
 * one purpose: letting two actual browsers talk to the actual gateway with
 * actual Durable Objects, because every bug in this feature so far has lived
 * in the gap between "the tests pass" and "somebody typed".
 *
 * **Not a product component, and never reachable from one.** It mints grants
 * for fixed fake tokens, holds no real credential, and is started by the
 * verification script and killed with it. It lives under `test/` for that
 * reason.
 */

import { createServer } from "node:http";
import { webcrypto } from "node:crypto";

const encoder = new TextEncoder();

async function sha256Hex(value) {
  const digest = await webcrypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The people in this verification, and what each may do.
 *
 * A reader is included deliberately: "a read-only member cannot mutate the
 * document" is one of the properties to demonstrate in a browser, and it
 * cannot be demonstrated without somebody holding that grant.
 */
const PEOPLE = [
  {
    token: "cat_local_verification_token_ana",
    user: "user_ana",
    slug: "ana",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
  },
  {
    token: "cat_local_verification_token_bo",
    user: "user_bo",
    slug: "bo",
    role: "editor",
    scopes: ["context:read", "context:write"],
  },
  {
    token: "cat_local_verification_token_reader",
    user: "user_reader",
    slug: "reader",
    role: "member",
    scopes: ["context:read"],
  },
];

const WORKSPACE_ID = "ws_local_verify";

export async function startLocalControlPlane({ port, gatewaySecret, bindingName }) {
  const byHash = new Map();
  for (const person of PEOPLE) {
    byHash.set(await sha256Hex(person.token), person);
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // The gateway secret proves "this caller is the gateway". Checked here
      // for the same reason the real one checks it: a stub more permissive
      // than the thing it stands in for makes every check a test of its
      // manners.
      if (req.headers.authorization !== `Bearer ${gatewaySecret}`) {
        return send(401, { error: "bad_secret" });
      }

      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return send(400, { error: "bad_json" });
      }

      if (req.url === "/gateway/session") {
        const person = byHash.get(await sha256Hex(String(parsed.accessToken ?? "")));
        if (!person) return send(200, { session: null });
        return send(200, {
          session: {
            grantId: `grant_${person.user}`,
            clientId: `client_${person.user}`,
            clientName: null,
            actorUserId: person.user,
            scopes: person.scopes,
            expiresAt: Date.now() + 60 * 60 * 1000,
            /*
              The shared workspace is everybody's default, which is what puts
              all three of them in one room: `selectWorkspace` reads
              `defaultWorkspaceId` when the URL carries no slug, and the
              presence route derives the room from the workspace it lands on.
              Naming the workspace in some other field — which an earlier
              version of this stub did — gets a 401 from `normalizeSession`,
              not a wrong room, because a missing `defaultWorkspaceId` is a
              control plane the gateway does not recognize.
            */
            defaultWorkspaceId: WORKSPACE_ID,
            // A personal workspace each, so `presenceDisplayName` has a handle
            // to stamp on the frame — which is what makes the caret labels real
            // rather than "Someone".
            workspaces: [
              { workspaceId: WORKSPACE_ID, slug: "verify", role: person.role, kind: "shared" },
              {
                workspaceId: `ws_${person.user}`,
                slug: person.slug,
                role: "owner",
                kind: "personal",
              },
            ],
          },
        });
      }

      if (req.url === "/gateway/binding") {
        const person = byHash.get(await sha256Hex(String(parsed.accessToken ?? "")));
        if (!person) return send(200, { binding: null });
        // Four siblings on this response, exactly as `getStorageBinding`
        // documents. Only `binding` is required; the other three are absent in
        // the ordinary case and absent here.
        return send(200, {
          binding: {
            workspaceId: WORKSPACE_ID,
            provider: "r2-binding",
            bindingName,
            capabilities: {
              conditionalWrite: true,
              conditionalCreate: true,
              conditionalDelete: true,
            },
            status: "active",
          },
        });
      }

      // Everything else this verification does not exercise.
      return send(200, null);
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    people: PEOPLE,
    workspaceId: WORKSPACE_ID,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
