/**
 * `read_notes` over paths that name other workspaces (`@band/gigs/show.md`), as
 * a search across workspaces writes them (`search.js`).
 *
 * One path reaches another workspace by the `@name/path` sugar in
 * `tools/session.js` (`addressByPath`), which moves the name to `context`. A
 * list of paths had no such door: every `@band/...` path in `read_notes` was
 * looked up in the caller's own workspace and came back "not found", and Tex
 * spent a round reading them again one by one (core benchmark q16 and q17,
 * 2026-11-05). Here the list is split by the workspace each path names and each
 * part is one ordinary call back through `callToolForSession`, with its own
 * `context`, so routing and every gate stay where they are; the parts come back
 * in the order they were asked.
 */

const BY_NAME = /^(@[a-z0-9][a-z0-9-]*)\/(.+)$/;

/** Whether a `read_notes` call names another workspace in a path, and so needs splitting here. */
export function readsAcross(name, args) {
  if (name !== "read_notes" || !args || typeof args !== "object" || Array.isArray(args)) return false;
  if (args.context !== undefined && args.context !== null) return false;
  return Array.isArray(args.paths) && args.paths.some((path) => typeof path === "string" && BY_NAME.test(path));
}

/**
 * The call split by workspace, each part read by `call(args)` (a `read_notes` call), the answers joined in
 * the order of `args.paths`. A path read elsewhere is shown with its workspace in front, as search wrote it.
 */
export async function readNotesAcross(args, call) {
  const groups = new Map();
  const order = [];
  for (const path of [...new Set(args.paths)]) {
    const match = typeof path === "string" ? BY_NAME.exec(path) : null;
    const where = match ? match[1] : null;
    const inner = match ? match[2] : path;
    if (!groups.has(where)) groups.set(where, []);
    if (!groups.get(where).includes(inner)) groups.get(where).push(inner);
    order.push({ where, inner, asked: path });
  }
  const { paths: _paths, ...rest } = args;
  const answers = new Map(
    await Promise.all(
      [...groups].map(async ([where, paths]) => [where, { paths, result: await call({ ...rest, paths, ...(where === null ? {} : { context: where }) }) }])
    )
  );
  const content = order.map(({ where, inner, asked }) => {
    const { paths, result } = answers.get(where);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const part = parts.length === paths.length ? parts[paths.indexOf(inner)] : null;
    if (part && typeof part.text === "string") {
      const text = result.isError === true && !part.text.startsWith("path: ") ? `path: ${asked}\nerror: ${part.text}` : part.text;
      return { type: "text", text: where === null ? text : `workspace: ${where}\n${text}` };
    }
    const why = parts.map((p) => p?.text ?? "").join("\n") || "not found";
    return { type: "text", text: `path: ${asked}\nerror: ${why}` };
  });
  const allFailed = [...answers.values()].every(({ result }) => result?.isError === true);
  return allFailed ? { content, isError: true } : { content };
}
