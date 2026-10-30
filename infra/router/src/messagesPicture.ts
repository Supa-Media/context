/**
 * A card Tex drew, served again for the page its Context card opens
 * (`/messages/card?p=…`, `messagesCards.ts`), at
 * `/messages/picture?p=<object id>.<token>.<ext>`.
 *
 * The owner, 2026-10-30: a tapped card showed only its title. The drawing is
 * kept by the texting Worker (`apps/agent/src/media.ts`, a week for a card)
 * under a 256-bit token, the same address Sendblue fetched it from; this reads
 * it through the `TEXTS` binding, so the Worker's own address never appears in
 * a page. Only an image type is passed on, and every miss is the same 404.
 */

export const PICTURE_PATH = "/messages/picture";
export const PICTURE_KEY = /^([0-9a-f]{64})\.([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const missing = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

/** The picture for `/messages/picture`, or null for any other path. */
export async function pictureResponse(request: Request, url: URL, env: { TEXTS?: Fetcher }): Promise<Response | null> {
  if (url.pathname !== PICTURE_PATH) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const key = PICTURE_KEY.exec(url.searchParams.get("p") ?? "");
  if (key === null || env.TEXTS === undefined) return missing();
  try {
    const answer = await env.TEXTS.fetch(`https://texts/media/${key[1]}/${key[2]}.${key[3]}`, { signal: AbortSignal.timeout(5_000) });
    const type = (answer.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!answer.ok || !TYPES.has(type)) return missing();
    return new Response(answer.body, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return missing();
  }
}
