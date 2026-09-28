/**
 * OpenAI's domain check for a ChatGPT plugin listing.
 *
 * Before OpenAI lists a plugin whose server lives on a domain, it fetches
 * `/.well-known/openai-apps-challenge` there and expects the token its portal
 * issued, and nothing else, as the body. The token proves we control the
 * domain; it is public the moment it is served, so it is an ordinary
 * `OPENAI_APPS_CHALLENGE` var rather than a secret.
 *
 * Only the bare origin answers. A workspace-prefixed path
 * (`/@seyi/.well-known/...`) is somebody's context, not the domain, and an
 * unset or malformed token answers 404 so a self-hosted gateway that never
 * listed anything says nothing at this path.
 */

export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

const TOKEN = /^[A-Za-z0-9._~-]{8,512}$/;

export function openaiAppsChallengeResponse(request, env, { slug, path }) {
  if (path !== OPENAI_APPS_CHALLENGE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const token = String(env.OPENAI_APPS_CHALLENGE ?? "").trim();
  if (slug || !TOKEN.test(token)) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : token, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
