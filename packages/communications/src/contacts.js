// Contact pages: one stable note per canonical person or organization.
//
// ## A contact page is a derived index that is allowed to be edited
//
// Two halves in one file, and the seam between them is the whole design. The
// **activity** half is regenerated from the channel-day notes and is a list of
// links, never content — a contact page that quoted messages would be a second
// copy of them, and the first thing to go stale. The **human** half — the
// preferred name, the organization, anything typed under `## Notes` — is
// theirs, verbatim, and is never rewritten. Same rule as `## My notes` in a
// meeting note, for the same reason.
//
// ## Automatic merging happens on exact identifier equality and nothing else
//
// Two events sharing a normalized address, phone number or provider user id
// are the same contact. Everything weaker — the same display name, the same
// domain, Google People saying so — produces a *suggestion* a person confirms,
// and the page records why it was linked. Google People data is evidence, not
// truth: it is a directory somebody else administers, and letting it merge
// silently means a colleague's address change re-attributes a year of
// somebody's correspondence.
//
// **A merge never rewrites a channel-day note.** The messages are what
// happened; this page is a view of them. So an unmerge is deleting and
// regenerating one file rather than unpicking a year of edits.

import { contactSlug } from "./paths.js";
import { defangOutsideFence, singleLine } from "./note.js";

/** The identifier kinds a contact can be recognised by. */
export const IDENTIFIER_KINDS = Object.freeze(["email", "phone", "chat", "provider-user"]);

/** Everything below this heading belongs to the person, not to the renderer. */
export const NOTES_HEADING = "## Notes";

/** Where the regenerated half starts. */
export const ACTIVITY_HEADING = "## Activity";

/**
 * One identifier, canonicalized for comparison.
 *
 * Case and surrounding whitespace never distinguish two people. Phone numbers
 * keep only their digits and a leading `+`, because the same number is written
 * six ways. Anything this cannot make sense of returns `null` and therefore
 * matches nothing — a value that fails to normalize must not become a wildcard
 * that merges every contact holding an equally broken one.
 *
 * @param {{kind: string, value: string}} identifier
 * @returns {string|null} `kind:value`, or null.
 */
export function normalizeIdentifier(identifier) {
  const kind = String(identifier?.kind ?? "");
  if (!IDENTIFIER_KINDS.includes(kind)) return null;
  const raw = singleLine(identifier?.value).toLowerCase();
  if (!raw) return null;

  if (kind === "email") {
    // One `@`, something either side. A local part is case-sensitive per RFC
    // and case-insensitive at every provider anybody uses; the providers win,
    // and the address as written is kept on the page regardless.
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? `email:${raw}` : null;
  }
  if (kind === "phone") {
    const digits = raw.replace(/[^0-9+]/g, "").replace(/(?!^)\+/g, "");
    // Seven digits is the shortest national number anywhere; below that a
    // "match" is an extension number colliding with another extension number.
    return digits.replace(/\D/g, "").length >= 7 ? `phone:${digits}` : null;
  }
  return `${kind}:${raw}`;
}

/** Every identifier a contact holds, canonical and deduplicated. */
export function identifierSet(contact) {
  const identifiers = Array.isArray(contact?.identifiers) ? contact.identifiers : [];
  return new Set(identifiers.map(normalizeIdentifier).filter((value) => value !== null));
}

/**
 * May these two be merged without asking?
 *
 * Only on a shared identifier. This function is deliberately hard to widen:
 * every weaker signal belongs in `suggestMerge`, where a person sees it.
 */
export function canAutoMerge(a, b) {
  const left = identifierSet(a);
  for (const value of identifierSet(b)) if (left.has(value)) return true;
  return false;
}

/**
 * What could be said about two contacts that do *not* share an identifier.
 *
 * Returns a suggestion with its reason, or `null`. Nothing here ever merges on
 * its own — the reason exists so the page can answer "why is this linked?",
 * which is the control the scoping note asks for.
 *
 * @returns {{confidence: "strong"|"weak", reason: string}|null}
 */
export function suggestMerge(a, b) {
  if (canAutoMerge(a, b)) return { confidence: "strong", reason: "shares an identifier" };

  const nameA = singleLine(a?.name).toLowerCase();
  const nameB = singleLine(b?.name).toLowerCase();
  if (nameA && nameA === nameB) {
    return { confidence: "weak", reason: "same display name, no shared identifier" };
  }

  const directoryA = String(a?.directoryId ?? "");
  const directoryB = String(b?.directoryId ?? "");
  if (directoryA && directoryA === directoryB) {
    // A directory somebody else administers. Evidence, never truth.
    return { confidence: "weak", reason: "the same directory entry claims both" };
  }
  return null;
}

/**
 * Merge two contacts into one, identifiers unioned and the human half kept.
 *
 * `preferred` wins every scalar it has a value for, so a person's own edit
 * survives an import that disagrees with it, and the disagreement is recorded
 * rather than dropped: `conflicts` is what the page prints beside the field.
 */
export function mergeContacts(preferred, other) {
  const conflicts = [...(preferred?.conflicts ?? []), ...(other?.conflicts ?? [])];
  for (const field of ["name", "organization"]) {
    const mine = singleLine(preferred?.[field]);
    const theirs = singleLine(other?.[field]);
    if (mine && theirs && mine !== theirs) conflicts.push(`${field}: also known as ${theirs}`);
  }

  const identifiers = [];
  const seen = new Set();
  for (const identifier of [
    ...(preferred?.identifiers ?? []),
    ...(other?.identifiers ?? []),
  ]) {
    const key = normalizeIdentifier(identifier);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    identifiers.push(identifier);
  }

  return {
    ...other,
    ...preferred,
    identifiers,
    conflicts,
    activity: [...(preferred?.activity ?? []), ...(other?.activity ?? [])],
    notes: singleLine(preferred?.notes) ? preferred.notes : (other?.notes ?? preferred?.notes ?? ""),
  };
}

/**
 * One activity entry as a wikilink into the day it happened.
 *
 * `[[path#anchor|label]]` — the form `links.js` already resolves and rewrites
 * when a note moves, so a contact page's links survive somebody tidying their
 * folders.
 *
 * The label is a **subject**, which a stranger wrote. `]]` in it would close
 * the link this line opened and `[[` would open one the sender chose, in a
 * page presented as the owner's own — so it goes through
 * `defangOutsideFence`, which is the fence rule for the file that has no
 * fence. The `path` is ours; it is built by `channelDayNotePath` and never
 * from a message.
 */
export function activityLink(entry) {
  const path = String(entry?.path ?? "").replace(/\.md$/, "");
  const anchor = String(entry?.anchor ?? "");
  const target = anchor ? `${path}#${anchor}` : path;
  const label = defangOutsideFence(singleLine(entry?.label)) || String(entry?.date ?? "");
  return `[[${target}|${label}]]`;
}

/** `2026-09` from a `2026-09-07`, for the month headings. */
function monthOf(date) {
  return String(date ?? "").slice(0, 7);
}

/**
 * The contact page, as Markdown. Pure: same inputs, same bytes.
 *
 * Activity is grouped by year and month **in the body**, which is where a
 * `YYYY/MM` grouping belongs: a heading somebody reads, not a directory
 * somebody walks.
 *
 * @param {{name: string, slug?: string, organization?: string,
 *          identifiers?: Array<{kind: string, value: string}>,
 *          conflicts?: string[],
 *          activity?: Array<{date: string, path: string, anchor?: string, label?: string, channel?: string}>,
 *          notes?: string, now?: string}} contact
 */
export function renderContactNote(contact) {
  if (!contact || typeof contact !== "object") throw new TypeError("renderContactNote needs a contact");
  const name = singleLine(contact.name) || "(unnamed contact)";
  const slug = contact.slug ? String(contact.slug) : contactSlug(name);

  const out = [
    "---",
    // `singleLine` *and* a JSON string literal on every value, which is the
    // rule protocol.js states for the day note. `slug` had only the second
    // layer, and a defence that is two layers in one renderer and one in the
    // other is one layer.
    `updated: ${JSON.stringify(singleLine(contact.now ?? new Date().toISOString()))}`,
    'type: "contact"',
    `slug: ${JSON.stringify(singleLine(slug))}`,
    "---",
    "",
    `# ${defangOutsideFence(name)}`,
    "",
  ];

  const organization = singleLine(contact.organization);
  if (organization) out.push(`**Organization:** ${defangOutsideFence(organization)}`, "");

  const identifiers = (contact.identifiers ?? []).filter((identifier) => normalizeIdentifier(identifier) !== null);
  if (identifiers.length) {
    out.push("## Identifiers", "");
    for (const identifier of identifiers) {
      out.push(`- ${singleLine(identifier.kind)}: ${defangOutsideFence(singleLine(identifier.value))}`);
    }
    out.push("");
  }

  const conflicts = (contact.conflicts ?? []).map((value) => singleLine(value)).filter(Boolean);
  if (conflicts.length) {
    out.push("## Disagreements", "");
    out.push(
      "_A later import disagreed with what is written above. What is above was kept; this is",
      "what it said, so the choice is visible rather than silently made._",
      ""
    );
    for (const conflict of conflicts) out.push(`- ${defangOutsideFence(conflict)}`);
    out.push("");
  }

  out.push(ACTIVITY_HEADING, "");
  out.push("_Links only. The messages live in the day they arrived in, and this list is", "regenerated from them._", "");

  const activity = [...(contact.activity ?? [])].sort((a, b) => {
    const byDate = String(b?.date ?? "").localeCompare(String(a?.date ?? ""));
    return byDate || String(a?.anchor ?? "").localeCompare(String(b?.anchor ?? ""));
  });
  if (!activity.length) {
    out.push("_(nothing yet)_", "");
  } else {
    let month = null;
    for (const entry of activity) {
      const entryMonth = monthOf(entry?.date);
      if (entryMonth !== month) {
        month = entryMonth;
        out.push(`### ${month}`, "");
      }
      const channel = singleLine(entry?.channel);
      out.push(`- ${entry?.date ?? "undated"}${channel ? ` · ${channel}` : ""} — ${activityLink(entry)}`);
    }
    out.push("");
  }

  // Last, and last for a reason: everything below this heading is the person's
  // and is copied through untouched, so a regeneration that appends can never
  // land inside it.
  out.push(NOTES_HEADING, "", String(contact.notes ?? "").trim(), "");
  return out.join("\n");
}

/**
 * Read back the half of a contact page that belongs to the person.
 *
 * Called before every regeneration. A parser that returned "" on a page it did
 * not understand would delete somebody's writing, so an absent heading returns
 * `null` and the caller keeps what it had.
 *
 * @returns {{notes: string|null}}
 */
export function parseContactNote(text) {
  const source = String(text ?? "");
  const index = source.indexOf(`\n${NOTES_HEADING}`);
  if (index === -1) return { notes: null };
  return { notes: source.slice(index + NOTES_HEADING.length + 1).trim() };
}
