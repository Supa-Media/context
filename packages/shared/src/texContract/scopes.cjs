/**
 * The scope strings a Context grant carries, and the one check on them.
 *
 * Shared by the gateway and Tex, so both name a scope the same way. `apps/mcp/src/session.js` re-exports these, and
 * keeps `SCOPE_CAPTURE` and `SUPPORTED_SCOPES` (no Tex code names them).
 */

/** Read every visible note. */
const SCOPE_READ = "context:read";
/** Create, update, move, and archive notes. Implies capture. */
const SCOPE_WRITE = "context:write";

/**
 * Reach notes marked private.
 *
 * Not an operation — holding it lets a client *do* nothing new. It widens the
 * set of notes every other scope applies to, which is why it is the one scope
 * a person is asked about separately on the consent screen and the one a
 * client's request cannot decide.
 */
const SCOPE_PRIVATE = "context:private";

function hasScope(session, scope) {
  return Array.isArray(session?.scopes) && session.scopes.includes(scope);
}

module.exports = { SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE, hasScope };
