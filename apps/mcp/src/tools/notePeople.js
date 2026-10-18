/**
 * `set_visibility`'s `people`: who else may open one note, named by an AI client.
 *
 * Each entry is `{ who, role }`: `who` is a member's or a group's `@handle`, or anyone's email address, and
 * `role` is `view` (the default) or `edit`. The control plane resolves the names and adds them to the row's
 * list (`nodesAccess.addGrantees`), owner only, and refuses the whole call with one answer when any name
 * resolves to nobody, so the answer never says which name exists.
 *
 * Naming somebody lets more people see the note, so the egress gate holds every such call for the person's yes
 * before it reaches this file (`privacy/egress.js`), whatever the client read. `parsePeople` is shared with the
 * gate so the two read an entry the same way, a domain included: a domain is held like anybody else, and then
 * refused here, since a note's list names people, not domains.
 */

import { toolError, toolText } from "./results.js";

export const MAX_PEOPLE = 100;

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const HANDLE = /^@[a-z0-9][a-z0-9-]{0,62}$/i;
/** `acme.com`, `@acme.com`, `*@acme.com`: everyone at an address, not one person. */
const DOMAIN = /^(?:\*?@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * The entries as the gate and the tool read them, or `null` when `people` is absent.
 *
 * @returns {null | Array<{who: string, kind: "email"|"handle"|"domain"|"unknown", role: "view"|"edit"}>}
 */
export function parsePeople(people) {
  if (people === undefined || people === null) return null;
  const list = Array.isArray(people) ? people : [people];
  return list.map((entry) => {
    const raw = typeof entry === "string" ? entry : entry?.who;
    const who = typeof raw === "string" ? raw.trim() : "";
    const role = entry?.role === "edit" ? "edit" : "view";
    const kind = DOMAIN.test(who) ? "domain" : EMAIL.test(who) ? "email" : HANDLE.test(who) ? "handle" : "unknown";
    return { who, kind, role };
  });
}

/** What the person is asked about, in plain words: "@ana (edit), lk@example.com and everyone at acme.com". */
export function describePeople(parsed) {
  const names = parsed.map((entry) => {
    const name = entry.kind === "domain" ? `everyone at ${entry.who.replace(/^\*?@/, "")}` : entry.who || "somebody";
    return entry.role === "edit" ? `${name} (who may edit it)` : name;
  });
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Add the people to the note at `path`. `store.rowAccess` is the rows-mode authority. */
export async function addPeopleToNote(store, path, people) {
  const parsed = parsePeople(people) ?? [];
  if (parsed.length === 0) return toolError("people is empty: name at least one @handle or email address");
  if (parsed.length > MAX_PEOPLE) return toolError(`people may name at most ${MAX_PEOPLE} at once`);
  const domain = parsed.find((entry) => entry.kind === "domain");
  if (domain) {
    return toolError(
      `a note is shared with people, not a whole domain: name each address at ${domain.who.replace(/^\*?@/, "")}, or ask the owner to share a link with the domain from the app`,
    );
  }
  const bad = parsed.find((entry) => entry.kind === "unknown");
  if (bad) return toolError(`"${bad.who}" is neither an @handle nor an email address`);
  if (!store.rowAccess?.addPeople) {
    return toolError("naming people on a note is not available for this workspace yet; share a link from the app instead");
  }
  const entries = parsed.map((entry) =>
    entry.kind === "email" ? { email: entry.who, role: entry.role } : { handle: entry.who, role: entry.role },
  );
  const answer = await store.rowAccess.addPeople(path, entries);
  if (answer?.ok === true) return toolText(`shared: ${path}\nwith: ${describePeople(parsed)}`);
  switch (answer?.code) {
    case "GRANTEE_NOT_FOUND":
      return toolError(
        "nothing changed: one of those names is not a member or a group of this workspace. Name someone outside it by their email address.",
      );
    case "FORBIDDEN":
      return toolError("permission denied: only the workspace's owner can name people on a note");
    case "NOT_FOUND":
      return toolError("not found");
    case "NOT_ROWS_MODE":
      return toolError("naming people on a note is not available for this workspace yet; share a link from the app instead");
    default:
      return toolError("nothing changed: the people could not be added right now; try again");
  }
}
