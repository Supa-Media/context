/**
 * The pages Tex made in a chat, on the Tex page (owner, 2026-11-10: pages are
 * "the default for all work output done through Tex", and the "Pages" list on
 * the Tex page is where they are found again).
 *
 *  `{view: "pages"}` → `{pages: [{context, path, title, at}]}`: every `.page.md`
 *  this chat's turns and jobs wrote, newest first, each once, read from the
 *  chat's own ledger: a successful `write` or `write_note` call names the
 *  path, and the workspace when it named one. Nothing is kept here.
 *
 * A link opens through the note's own access rules (`/p/@slug/<path>`), so a
 * page listed here that the reader can no longer open opens to "no access",
 * exactly as its texted link would. Who may, and which chat: `page.js`.
 */

/** The most pages one list answers. */
export const MAX_PAGES = 40;
/** Tool calls read for one list: newest first, a page of the chat's ledger at a time. */
const READ_PAGE = 500;
const READ_PAGES = 8;

const WRITES = new Set(["write", "write_note"]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A page this tool call wrote, as `{context, path}`, or null. `home` is the chat's own workspace. */
export function pageWritten(entry, home) {
  if (entry?.kind !== "tool" || entry.ok !== true || !WRITES.has(entry.name)) return null;
  const args = entry.args && typeof entry.args === "object" ? entry.args : {};
  if (typeof args.action === "string" && args.action !== "" && args.action !== "save") return null;
  const path = typeof args.path === "string" ? args.path.trim().replace(/^\/+/, "") : "";
  if (!/\.page\.md$/i.test(path) || path.length > 1024 || path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const named = typeof args.context === "string" && args.context.trim() !== "" ? args.context.trim().replace(/^@+/, "").toLowerCase() : home;
  if (typeof named !== "string" || !SLUG.test(named)) return null;
  return { context: named, path };
}

/** A page's name as the list shows it: its file name, without `.page.md`, its dashes as spaces. */
export function pageName(path) {
  const leaf = path.split("/").pop() ?? path;
  const words = leaf.replace(/\.page\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words === "" ? leaf : words.charAt(0).toUpperCase() + words.slice(1);
}

export async function pagesView(ledger, chat, home) {
  const seen = new Set();
  const pages = [];
  let before = Number.MAX_SAFE_INTEGER;
  for (let read = 0; read < READ_PAGES && pages.length < MAX_PAGES; read += 1) {
    const answer = await ledger.read(chat, { before, kinds: ["tool"], limit: READ_PAGE });
    for (const entry of Array.isArray(answer?.entries) ? answer.entries : []) {
      const page = pageWritten(entry, home);
      if (page === null) continue;
      const key = `${page.context}/${page.path.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push({ ...page, title: pageName(page.path), at: Number.isSafeInteger(entry.at) ? entry.at : 0 });
      if (pages.length >= MAX_PAGES) break;
    }
    if (!Number.isSafeInteger(answer?.before)) break;
    before = answer.before;
  }
  return { pages };
}
