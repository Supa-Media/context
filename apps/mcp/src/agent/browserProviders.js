/**
 * The browsers behind `computerFor` (`computer.js`), both reached through the
 * `SITE_SHOTS` service binding (`infra/site-shots`):
 *
 * - **Cloudflare Browser Rendering** reads pages (POST /read) and, until
 *   Browserbase is configured, drives one browser per question (POST
 *   /browse), closed when the question is answered.
 * - **Browserbase** (decided 2026-10-10) drives the browser once
 *   `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` reach the screenshot
 *   Worker. Nothing here needs configuring to switch: the gateway asks for
 *   Browserbase first, and a Worker without its key answers 501, after which
 *   this isolate uses Cloudflare's browser. Its browser outlives the question
 *   (up to 15 minutes, `infra/site-shots/src/browserbase.ts`), found again by
 *   the person's tag, so a person can sign in through the live-view link and
 *   text Tex to carry on.
 *
 * The tag is an HMAC of the person's user id under `GATEWAY_SECRET`: the
 * screenshot Worker and Browserbase see a value that names nobody and cannot
 * be produced for another person without the secret.
 */

/** Set once a Worker says it has no Browserbase key; a deploy starts a new isolate. */
let browserbaseMissing = false;

/** For tests: forget what an earlier Worker said. */
export function resetBrowserbaseProbe() {
  browserbaseMissing = false;
}

/** The person's browser tag, or null when this deployment cannot make one. */
export async function browserOwner(env, userId) {
  const secret = typeof env?.GATEWAY_SECRET === "string" ? env.GATEWAY_SECRET : "";
  if (!secret || typeof userId !== "string" || !userId) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`tex-browser:${userId}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(binding, path, body) {
  return await binding.fetch(`https://site-shots${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What a /browse answer means to `browse.js`. A failed call still names its browser. */
async function browseResult(response) {
  const body = await response.json().catch(() => null);
  if (typeof body?.session === "string") {
    return response.ok ? body : { session: body.session, ran: [], page: null };
  }
  throw new Error("browser unavailable");
}

export function siteShotsComputer(env, { owner = null } = {}) {
  const binding = env?.SITE_SHOTS;
  if (typeof binding?.fetch !== "function") return null;
  // Which browser this question's `browse` ended up on.
  let onBrowserbase = false;
  const browserbaseWanted = () => typeof owner === "string" && owner.length > 0 && !browserbaseMissing;

  return {
    provider: "cloudflare",
    async readPage(url) {
      const response = await post(binding, "/read", { url });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.page || typeof body.page.text !== "string") {
        throw new Error("page unreadable");
      }
      return body.page;
    },

    async browse(session, steps, { handoff = false } = {}) {
      if (browserbaseWanted()) {
        const response = await post(binding, "/browse", { provider: "browserbase", owner, steps, ...(handoff ? { handoff: true } : {}) });
        if (response.status !== 501) {
          onBrowserbase = true;
          return await browseResult(response);
        }
        browserbaseMissing = true;
      }
      return await browseResult(await post(binding, "/browse", session === null ? { steps } : { session, steps }));
    },

    /** Whether a question may carry on in a browser an earlier one opened. */
    mayResume: () => browserbaseWanted(),
    /** Whether a person can be handed this browser to sign in. */
    canHandOff: () => browserbaseWanted(),
    /**
     * Cloudflare's browser closes with the question. Browserbase's stays for
     * the next one, ending itself, so a sign-in can be carried on from.
     */
    async closeBrowser(session) {
      if (onBrowserbase) return;
      await post(binding, "/browse/close", { session });
    },
  };
}
