/**
 * What Tex takes from the gateway it runs in, without importing it (`texContract/contextGateway.cjs`), and the pure
 * privacy and identity logic the two now share (`texContract/identity.cjs`, `scopeClamp.cjs`, `egressLedger.cjs`).
 *
 * Fails if:
 *  - loading the dispatcher stops connecting the gateway, or connects something other than its own functions;
 *  - anything can swap the dispatcher Tex calls through once it is connected;
 *  - Tex's seams answer otherwise than the gateway's own privacy engine and egress ledger;
 *  - the pinned workspace's name in the shared identity drifts from `orient/globalNote.js`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { callTexAction, callToolForSession } from "../src/tools/session.js";
import { recordRead } from "../src/privacy/egress.js";
import { isPlumbing, readsAsChat, READS_AS_CHAT } from "../src/privacy/engine.js";
import { createControlPlane } from "../src/controlPlane.js";
import { judgeWords } from "../src/privacy/judge.js";
import { PINNED_CONTEXT_NAME } from "../src/orient/globalNote.js";
import { reachForRole } from "../src/session.js";
import { contextsFor, editsPinnedContext } from "../src/context/identity.js";
import { CONTEXT_GATEWAY_PARTS, connectContextGateway, contextGateway } from "../../../packages/shared/src/texContract/contextGateway.cjs";
import * as identity from "../../../packages/shared/src/texContract/identity.cjs";
import { isPlumbingKey, namesReadAsChat, recordContextRead, teamCanSee } from "../../../packages/tex/gateway/contextMcp.js";
import { newLedger } from "../../../packages/shared/src/texContract/egressLedger.cjs";

test("loading the dispatcher connects the gateway's own functions, and nothing can swap them after", () => {
  const parts = contextGateway();
  assert.equal(parts.callTool, callToolForSession);
  assert.equal(parts.callTexAction, callTexAction);
  assert.equal(parts.recordRead, recordRead);
  assert.equal(parts.controlPlane, createControlPlane);
  assert.equal(parts.isPlumbing, isPlumbing);
  assert.equal(parts.readsAsChat, readsAsChat);
  assert.equal(parts.judgeWords, judgeWords, "Tex's egress step asks the gateway's own judge");
  assert.ok(Object.isFrozen(parts));
  const forged = Object.fromEntries(CONTEXT_GATEWAY_PARTS.map((name) => [name, () => true]));
  assert.throws(() => connectContextGateway(forged), /already connected/);
  assert.throws(() => connectContextGateway({ ...parts, callTool: async () => ({ content: [] }) }), /already connected/);
  assert.equal(contextGateway().callTool, callToolForSession, "a refused connect leaves the gateway's dispatcher in place");
  connectContextGateway({ ...parts }); // the very same functions: a no-op
  assert.throws(() => connectContextGateway({ ...parts, teamCanSee: undefined }), /teamCanSee must be a function/);
});

test("Tex's seams answer as the gateway's privacy engine and egress ledger do", async () => {
  assert.equal(isPlumbingKey("privacy.md"), isPlumbing("privacy.md"));
  assert.equal(isPlumbingKey("projects/plan.md"), false);
  assert.equal(namesReadAsChat(new Set([READS_AS_CHAT])), true);
  assert.equal(namesReadAsChat(new Set(["@team"])), false);
  const mail = newLedger();
  recordContextRead(mail, { name: "read_note", args: { path: "trips/lisbon.md" }, result: { content: [{ type: "text", text: "---\ntrust: untrusted\n---\n# From a stranger" }] } });
  assert.equal(mail.untrusted, true, "a note ingestion marked untrusted is somebody else's words");
  const own = newLedger();
  recordContextRead(own, { name: "read_note", args: { path: "trips/lisbon.md" }, result: { content: [{ type: "text", text: "# Lisbon" }] } });
  assert.equal(own.untrusted, false);
  // A store whose rules can't be read reads nothing.
  assert.equal(await teamCanSee({ get: async () => { throw new Error("down"); } }, "projects/plan.md"), false);
});

test("the shared identity is the gateway's: one pinned name, one role clamp", () => {
  assert.equal(identity.PINNED_CONTEXT_NAME, PINNED_CONTEXT_NAME);
  const session = {
    workspaceId: "w1",
    grantScopes: ["context:read", "context:write"],
    workspaces: [
      { workspaceId: "w1", slug: "sam", kind: "personal", role: "owner" },
      { workspaceId: "w2", slug: "context-lc", kind: "shared", role: "member" },
    ],
  };
  assert.deepEqual(identity.contextsFor(session), contextsFor(session));
  const [own, pinned] = contextsFor(session);
  assert.deepEqual({ canWrite: own.canWrite, tier: own.tier }, { canWrite: true, tier: "team" }, "no context:private, so an owner reads at team");
  assert.equal(pinned.canWrite, false, "a member never writes, whatever the grant");
  assert.equal(editsPinnedContext(session), false);
  assert.deepEqual(reachForRole({ grantScopes: ["context:read", "context:private"] }, "owner"), { tier: "private", canWrite: false, grantWrites: false });
  assert.deepEqual(reachForRole({ grantScopes: ["context:read", "context:private"] }, "editor"), { tier: "team", canWrite: false, grantWrites: false });
});
