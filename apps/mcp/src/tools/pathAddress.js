/**
 * Where a tool call's paths say it goes: the `@name/path` sugar, read in the one place
 * routing is decided (`session.js` `callToolForSession`). Moved out of `session.js` whole.
 */

/** `@name/rest` → `{ name: "@name", rest }`, or null for a plain path. */
const BY_NAME = /^(@[a-z0-9][a-z0-9-]*)\/(.+)$/;

/** The arguments that carry a path into the addressed context, and the context argument each pairs with. */
const PATH_ARGUMENTS = [
  ["path", "context"],
  ["note", "context"],
  ["prefix", "context"],
  ["source", "source_context"],
  ["destination", "destination_context"],
];

/**
 * Route a call from a path that opens with a workspace's name.
 *
 * Returns a refusal when the call's paths name more than one place, and
 * nothing when they agree.
 *
 * **A call names one place.** `move_note` is the exception that proves it: it
 * carries a context per side, so each path addresses its own end. Every other
 * tool routes the whole call, so the first path argument that speaks decides
 * where the call runs, and the rest are read there. A later path naming a
 * *different* workspace — including the plain path of a caller who named the
 * other side and not this one — has asked for two places at once, and is
 * refused rather than quietly collapsed into one of them. Routing
 * `{ source: "5-notes", destination: "@band/4-archive/5-notes" }` to `@band`
 * moved @band's folder and left the caller's where it was (found by reading,
 * 2026-10-10).
 */
export function addressByPath(tool, args) {
  if (!args || typeof args !== "object") return;
  if (tool === "move_note") {
    for (const [field, into] of PATH_ARGUMENTS) {
      if (args[into] !== undefined && args[into] !== null) {
        const twice = addressedTwice(args, into, [field]);
        if (twice) return twice;
        continue;
      }
      const match = typeof args[field] === "string" ? BY_NAME.exec(args[field]) : null;
      if (!match) continue;
      args[into] = match[1];
      args[field] = match[2];
    }
    return;
  }
  // A call that addressed itself has already said where it is going.
  if (args.context !== undefined && args.context !== null) return addressedTwice(args);
  /** The workspace the first path argument named, `null` for "here". */
  let named = null;
  /** The argument that named it, and so the one a disagreement is measured against. */
  let decidedBy = null;
  for (const [field] of PATH_ARGUMENTS) {
    if (typeof args[field] !== "string") continue;
    const match = BY_NAME.exec(args[field]);
    if (decidedBy === null) {
      decidedBy = field;
      named = match ? match[1] : null;
      if (match) args[field] = match[2];
      continue;
    }
    // Plain, and so read in the place already named — which is how
    // `{ source: "@band/gigs", destination: "4-archive/gigs" }` moves inside @band.
    if (!match) continue;
    if (match[1] === named) {
      args[field] = match[2];
      continue;
    }
    return (
      "that call names more than one workspace: " +
      `${decidedBy} is ${named ? `in ${named}` : "in this context"} and ${field} opens with ${match[1]}. ` +
      "A path that names a workspace has to be the only workspace the call names."
    );
  }
  if (named !== null) args.context = named;
}

/** `@Band`, `band` and ` @band ` are one name, as `context` reads it. */
const foldedName = (name) => {
  const text = String(name).trim().toLowerCase();
  return text.startsWith("@") ? text : `@${text}`;
};

/**
 * A call that names `context` and also opens a path with a workspace's name.
 *
 * The same name twice says one place, so the name leaves the path: a cloud job
 * (2026-11-08, Tex Devs) read `{ path: "@supa/projects/tex/x.page.md", context: "@supa" }`
 * three times a part, its brief having named the page that way, and each came
 * back a bare "not found". A *different* name has asked for two places at once
 * and is refused with which one to drop, never quietly read as a folder called
 * `@name` (owner's choice, 2026-11-08).
 */
function addressedTwice(args, into = "context", fields = [...PATH_ARGUMENTS.map(([field]) => field), "paths"]) {
  if (typeof args[into] !== "string" || args[into].trim() === "") return;
  const named = foldedName(args[into]);
  for (const field of fields) {
    const value = args[field];
    const list = Array.isArray(value) ? value : [value];
    for (const path of list) {
      const match = typeof path === "string" ? BY_NAME.exec(path) : null;
      if (match && foldedName(match[1]) !== named) {
        return (
          `that call names two workspaces: ${into} is ${named} and ${field} opens with ${match[1]}. ` +
          `Name one: drop "${match[1]}/" from the path, or set ${into} to ${match[1]}.`
        );
      }
    }
    if (Array.isArray(value)) {
      args[field] = value.map((path) => (typeof path === "string" && BY_NAME.test(path) ? BY_NAME.exec(path)[2] : path));
    } else if (typeof value === "string" && BY_NAME.test(value)) {
      args[field] = BY_NAME.exec(value)[2];
    }
  }
}
