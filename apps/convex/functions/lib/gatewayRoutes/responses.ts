/**
 * The answer every gateway route gives for a failure on our side.
 *
 * Split out of `http.ts`, which still uses it for the routes it keeps; the
 * route handlers in this folder use it too.
 */

import { json } from "../gatewayAuth";

/** Something on our side broke. Says so, and says nothing else. */
export function serverError(): Response {
  return json({ error: "server_error" }, 500);
}
