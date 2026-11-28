/**
 * The gateway connects the parts Tex takes from it, instead of Tex importing them (`texContract/contextGateway.cjs`;
 * docs/decisions/texting-assistant/tex-service.md). Imported by the MCP dispatcher (`session.js`), so wherever the
 * dispatcher loads, Tex is connected to it. Every part is the gateway's own function, unchanged.
 */

import { callTexAction, callToolForSession } from "./session.js";
import { recordRead } from "../privacy/egress.js";
import { canSee, isPlumbing, readsAsChat } from "../privacy/engine.js";
import { loadPrivacyState } from "../privacy/state.js";
import { judgeWords } from "../privacy/judge.js";
import { createControlPlane } from "../controlPlane.js";
import { connectContextGateway } from "../../../../packages/shared/src/texContract/contextGateway.cjs";

/** Whether the store's members read `path`, by its own rules: a group chat's home reads as its chat (`groupGuests.js`). */
async function teamCanSee(store, path) {
  try {
    const { rules, overrides, error } = await loadPrivacyState(store);
    return !error && canSee(path, "team", rules, overrides, null);
  } catch {
    return false;
  }
}

connectContextGateway({ callTool: callToolForSession, callTexAction, recordRead, controlPlane: createControlPlane, isPlumbing, readsAsChat, teamCanSee, judgeWords });
