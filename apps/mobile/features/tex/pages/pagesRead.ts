/**
 * Reading the gateway's list of the pages a chat's turns and jobs wrote
 * (`apps/mcp/src/http/texPage/pages.js`). Pure: anything malformed is
 * dropped, never guessed at, and a body that is not this answer reads as null.
 */

export interface TexMadePage {
  /** The workspace it is in, as a slug without its `@`. */
  context: string;
  path: string;
  title: string;
  at: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function readPage(value: unknown): TexMadePage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.context !== "string" || !SLUG.test(r.context)) return null;
  if (typeof r.path !== "string" || !/\.page\.md$/i.test(r.path) || r.path.length > 1024 || r.path.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  const at = typeof r.at === "number" && Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : 0;
  const title = typeof r.title === "string" && r.title.trim() !== "" ? r.title.slice(0, 200) : r.path;
  return { context: r.context, path: r.path, title, at };
}

export function readPages(body: unknown): TexMadePage[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  // A chat with no ledger answers the history's empty shape: no pages yet.
  if (r.pages === undefined) return Array.isArray(r.entries) ? [] : null;
  if (!Array.isArray(r.pages)) return null;
  return r.pages.map(readPage).filter((p): p is TexMadePage => p !== null);
}
