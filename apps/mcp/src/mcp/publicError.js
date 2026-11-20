/**
 * What a caller is told when a call fails inside the gateway, and the one log line that says why.
 *
 * A failed save once reached a group chat as "control plane unavailable", with nothing anyone could quote back and no
 * log of which call failed (Dev2, 2026-11-20). So a failure a client sees is a short code and a plain sentence, and the
 * reason (route, status, error class) goes to this Worker's logs, never to the client: an error's own words can
 * carry a path or a value, and the caller may be an AI client on the internet.
 */

import { ControlPlaneError, controlPlaneErrorCode } from "../controlPlane/client.js";

const slug = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** The short code for a failure: a control plane call's own, else the error's class. */
export function failureCode(error) {
  const cp = controlPlaneErrorCode(error);
  if (cp !== null) return cp;
  const name = typeof error?.name === "string" && error.name !== "Error" ? slug(error.name) : "";
  return name === "" ? "INTERNAL" : `INTERNAL-${name}`;
}

/** The sentence a caller reads, with the code in it. */
export function failureText(code) {
  return `Context could not finish this just now (error ${code}). Try again in a moment; if it keeps failing, quote this code to whoever runs Context.`;
}

/**
 * One `mcp_call_failed` line: where (`method`, `tool`), the code, and for a control-plane failure its route and
 * status. Never the error's message, never an argument.
 */
export function logCallFailure(error, { method = null, tool = null } = {}) {
  const code = failureCode(error);
  try {
    console.error(JSON.stringify({
      event: "mcp_call_failed",
      ...(method ? { method } : {}),
      ...(typeof tool === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(tool) ? { tool } : {}),
      code,
      error: typeof error?.name === "string" ? error.name : typeof error,
      ...(error instanceof ControlPlaneError ? { route: error.route, status: error.status } : {}),
    }));
  } catch {
    // A log line never fails a call.
  }
  return code;
}
