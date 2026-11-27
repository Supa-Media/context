/**
 * The one builder of a note's app link, `<APP_ORIGIN>/note/@<slug>/<path>`, for
 * the gateway's MCP answers (`apps/mcp/src/notes/appLink.js`) and Tex's texted
 * ones (`packages/tex/gateway/agent/noteLinks.js`): two builders would drift.
 */
/** The deployment's https origin, without a trailing slash, or null. */
function appOriginOf(env) {
  const origin = typeof env?.APP_ORIGIN === "string" ? env.APP_ORIGIN.replace(/\/$/, "") : "";
  return /^https:\/\/[^/]+$/.test(origin) ? origin : null;
}

/**
 * `<origin>/note/@slug/<path>`, every segment encoded and the `@` left
 * readable; a page's is `<origin>/p/@slug/<path>`, which opens the page
 * viewer rather than the app (owner, 2026-11-10; `infra/router/src/pageViewer.ts`).
 */
function noteLinkUrl(origin, slug, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const route = /\.page\.md$/i.test(path) ? "p" : "note";
  return `${origin}/${route}/@${encodeURIComponent(slug)}/${encoded}`;
}

module.exports = { appOriginOf, noteLinkUrl };
