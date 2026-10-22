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
 *   (until five idle minutes pass, `infra/site-shots/src/idle.ts`), found again by
 *   the person's tag, so a person can sign in on it and text Tex to carry on.
 *   They take it over at `viewer`, their own `context.lc/tex/<handle>` page
 *   (`http/texComputer.js`), signed in; Browserbase's live-view link, which
 *   drives the browser for whoever holds it, is never asked for.
 *
 * The tag is an HMAC of the person's user id under `GATEWAY_SECRET`: the
 * screenshot Worker and Browserbase see a value that names nobody and cannot
 * be produced for another person without the secret.
 */

import { fileWords, typeOfFile } from "../tools/readFile.js";
import { pdfLinks } from "../tools/pdfLinks.js";

/** Set once a Worker says it has no Browserbase key; a deploy starts a new isolate. */
let browserbaseMissing = false;

/**
 * How long this isolate leaves Browserbase alone after it refuses to start a
 * browser for billing (402, 2026-10-14: every texted browser job failed on
 * it). Long enough not to ask on every call, short enough that paying the bill
 * brings it back without a deploy.
 */
export const BROWSERBASE_REFUSED_PAUSE_MS = 10 * 60 * 1000;
let browserbaseRefusedAt = null;

/** For tests: forget what an earlier Worker said. */
export function resetBrowserbaseProbe() {
  browserbaseMissing = false;
  browserbaseRefusedAt = null;
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

/**
 * What a /browse answer means to `browse.js`. A failed call still names its
 * browser. The sign-ins read back out of the browser go to `keep` and never
 * on (`browserJar.js`): nothing past this function sees them.
 */
async function browseResult(response, keep = null) {
  const body = await response.json().catch(() => null);
  if (typeof body?.session === "string") {
    const { jar, ...answer } = body;
    if (!response.ok) return { session: answer.session, ran: [], page: null };
    if (keep !== null && jar && typeof jar === "object") await keep.save(jar);
    // A link to hand over is the gateway's to make (`viewer`), never the
    // Worker's: an older one answered with Browserbase's live-view link here.
    const { liveUrl: _liveUrl, handoffUrl: _handoffUrl, ...result } = answer;
    return result;
  }
  throw new Error("browser unavailable");
}

/**
 * `jar` keeps the person's sign-ins between their Browserbase browsers
 * (`browserJar.js`); without one, each new browser starts signed out.
 */
export function siteShotsComputer(env, { owner = null, viewer = null, jar = null, now = Date.now } = {}) {
  const binding = env?.SITE_SHOTS;
  if (typeof binding?.fetch !== "function") return null;
  // Which browser this question's `browse` ended up on.
  let onBrowserbase = false;
  const refused = () => browserbaseRefusedAt !== null && now() - browserbaseRefusedAt < BROWSERBASE_REFUSED_PAUSE_MS;
  const browserbaseWanted = () => typeof owner === "string" && owner.length > 0 && !browserbaseMissing && !refused();

  async function browseOn(session, steps, handoff, fresh) {
    if (browserbaseWanted()) {
      // `handoff` tells the screenshot Worker (and the bench's stand-in for it)
      // the person is being handed this browser; it asks Browserbase for nothing.
      const held = jar !== null ? await jar.load() : null;
      const response = await post(binding, "/browse", {
        provider: "browserbase",
        owner,
        steps,
        ...(handoff ? { handoff: true } : {}),
        // A new browser, a new address: the last try past a captcha (`captchaLadder.js`).
        ...(fresh ? { fresh: true } : {}),
        ...(jar !== null ? { keep: true, ...(held !== null ? { jar: held } : {}) } : {}),
      });
      // 402: Browserbase won't start a browser until its bill is paid.
      // Cloudflare's browser does this question; nothing can be handed over.
      if (response.status === 402) browserbaseRefusedAt = now();
      else if (response.status !== 501) {
        onBrowserbase = true;
        const result = await browseResult(response, jar);
        // The person's own page, never a link to the browser itself.
        return handoff && typeof viewer === "string" ? { ...result, handoffUrl: viewer } : result;
      } else browserbaseMissing = true;
    }
    return await browseResult(await post(binding, "/browse", session === null ? { steps } : { session, steps }));
  }

  return {
    provider: "cloudflare",
    async readPage(url) {
      const response = await post(binding, "/read", { url });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.page || typeof body.page.text !== "string") {
        throw new Error("page unreadable");
      }
      return body.page.file ? await pdfPage(env?.AI, body.page) : body.page;
    },

    async browse(session, steps, { handoff = false, fresh = false } = {}) {
      return await withFileWords(env?.AI, await browseOn(session, steps, handoff, fresh));
    },

    /** Whether a question may carry on in a browser an earlier one opened. */
    mayResume: () => browserbaseWanted(),
    /** Whether a person can be handed this browser to sign in: Browserbase, and a page of theirs to do it on. */
    canHandOff: () => browserbaseWanted() && typeof viewer === "string" && viewer.length > 0,
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

/**
 * A downloaded file (`infra/site-shots/src/download.ts`) with its words, read
 * the way `read_file` reads one, so Tex can tell it took the right invoice
 * before emailing it. A file whose words can't be read goes on without them.
 */
export async function withFileWords(ai, result) {
  const file = result?.file;
  if (!file || typeof file.data !== "string") return result;
  let words = null;
  try {
    const bytes = Uint8Array.from(atob(file.data), (ch) => ch.charCodeAt(0));
    const type = typeOfFile(String(file.name ?? ""), bytes);
    const read = type === null ? null : await fileWords(ai, String(file.name ?? "file"), type, bytes);
    words = typeof read?.text === "string" ? read.text : null;
  } catch {
    words = null;
  }
  return words === null ? result : { ...result, file: { ...file, words } };
}

/**
 * A PDF the screenshot Worker handed on whole (`infra/site-shots/src/fetchText.ts`),
 * read the way `read_file` reads one: its words, and its links as links the
 * turn may follow, since a browser shows a PDF with no text at all
 * (2026-10-20: a race's course map and a payment link were both PDFs).
 */
export async function pdfPage(ai, page) {
  const { file, ...rest } = page;
  let bytes;
  try {
    bytes = Uint8Array.from(atob(String(file.data ?? "")), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("page unreadable");
  }
  const name = decodeURIComponent(new URL(page.url).pathname.split("/").pop() || "page.pdf");
  const read = await fileWords(ai, name, "application/pdf", bytes);
  const links = (await pdfLinks(bytes)).filter((href) => href.startsWith("https://")).map((href) => ({ text: "", href }));
  return {
    ...rest,
    title: rest.title || name,
    text: read.text ?? `(This is a PDF, and ${read.error}.)`,
    links,
  };
}
