/**
 * OAuth 2.1 for MCP — the discovery and authorization surface that makes
 * "paste this URL into ChatGPT" work.
 *
 * Verified against the MCP authorization specification (revision `2026-07-28`;
 * the `draft` text is byte-identical apart from version links), RFC 9728, RFC
 * 8414, RFC 7591, RFC 8707, RFC 8252 and RFC 7009, plus Anthropic's published
 * connector-authentication requirements. Where the spec and a real client
 * disagree, the comment says so.
 *
 * ## Why this exists at all
 *
 * The catch-all used to answer `/.well-known/oauth-protected-resource` with
 * `200 "context"`. A modern MCP client asks that URL first, gets a body that is
 * not metadata, and concludes there is no authorization server — so it never
 * starts a flow, and the only way in was a token pasted into a URL. Discovery
 * is not a nicety here; it is the difference between a connectable server and
 * an unconnectable one.
 *
 * ## The shape of the flow
 *
 * The gateway is the authorization server *and* the resource server, but it is
 * deliberately not the identity provider. `/oauth/authorize` validates the
 * request and then hands the browser to the control plane's own app, which is
 * where the person signs in and picks a workspace. This worker never sees a
 * password, never sees a user session cookie, and never decides who anyone is.
 * It sees an authorization code afterwards and nothing before.
 *
 * ## What is deliberately not here
 *
 *  - **No token introspection endpoint.** Nothing external needs it.
 *  - **No client_credentials.** Every connection is somebody's consent; a
 *    machine grant with no human behind it has no workspace to resolve to.
 *    (Claude does not support it either.)
 *  - **No `plain` PKCE.** See `verifyPkce`.
 */

/*
 * Split by responsibility into `src/oauth/`; this file re-exports exactly what
 * it exported before, so the worker and every test import it unchanged.
 */

export { registrantNetwork } from "./oauth/registrant.js";
export {
  publicOrigin,
  canonicalResources,
  resourceMatches,
  slugFromResource,
  challengeHeader,
  unauthorizedResponse,
  forbiddenResponse,
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "./oauth/discovery.js";
export { redirectUriMatches, handleRegister } from "./oauth/registration.js";
export { handleAuthorize } from "./oauth/authorize.js";
export { handleToken } from "./oauth/token.js";
export { handleRevoke } from "./oauth/revoke.js";
