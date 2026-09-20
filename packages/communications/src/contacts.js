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

import { contactNotePath, contactSlug, channelDayNotePath } from "./paths.js";
import { messageAnchor } from "./anchors.js";
import { defangOutsideFence, singleLine } from "./note.js";

/** The frontmatter `type` every contact page carries, and the only thing that identifies one. */
export const CONTACT_TYPE = "contact";

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

  const activity = [];
  const activitySeen = new Set();
  for (const entry of [...(preferred?.activity ?? []), ...(other?.activity ?? [])]) {
    const path = String(entry?.path ?? "").replace(/\.md$/, "");
    const key = `${path}\u0000${entry?.anchor ?? ""}\u0000${entry?.channel ?? ""}`;
    if (activitySeen.has(key)) continue;
    activitySeen.add(key);
    activity.push(entry);
  }

  return {
    ...other,
    ...preferred,
    identifiers,
    conflicts,
    activity,
    notes: singleLine(preferred?.notes) ? preferred.notes : (other?.notes ?? preferred?.notes ?? ""),
  };
}

/** The stable contact-page path for a draft, keyed by identity rather than a mutable display name. */
export function contactPathForDraft(contact, options = {}) {
  const keys = [...identifierSet(contact)].sort();
  if (!keys.length) return null;
  return contactNotePath(contactSlug(keys[0].replace(":", "-")), options);
}

function identifierForPerson(person) {
  const address = singleLine(person?.address);
  if (address) {
    const kind = address.includes("@") ? "email" : "phone";
    if (normalizeIdentifier({ kind, value: address }) !== null) return { kind, value: address };
  }
  const providerUserId = singleLine(person?.providerUserId);
  if (providerUserId) return { kind: "provider-user", value: providerUserId };
  return null;
}

/**
 * Build contact activity directly from the messages a provider sync already read.
 * No address-book API and no second crawl: contacts are a derived index of the
 * same normalized events that produced the channel-day note.
 */
export function contactDraftsFromCommunication(events, options = {}) {
  const own = new Set((options.selfAddresses ?? []).map((value) => String(value).trim().toLowerCase()));
  const ownProviderUsers = new Set((options.selfProviderUserIds ?? []).map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean));
  const drafts = [];
  for (const event of events ?? []) {
    const date = String(event?.sentAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day = event.channel === "email"
      ? { channel: event.channel, account: event.account, date }
      : { channel: event.channel, date };
    const path = channelDayNotePath(
      day,
      { root: options.root, folder: options.folder },
    );
    const people = [event?.from, ...(Array.isArray(event?.to) ? event.to : [])];
    for (const person of people) {
      const identifier = identifierForPerson(person);
      if (identifier === null) continue;
      const normalized = normalizeIdentifier(identifier);
      if (normalized === null) continue;
      if (identifier.kind === "email" && own.has(String(identifier.value).trim().toLowerCase())) continue;
      if (identifier.kind === "provider-user" && ownProviderUsers.has(String(identifier.value).trim().toLowerCase())) continue;
      if (singleLine(person?.name).toLowerCase() === "you" && !singleLine(person?.address)) continue;
      drafts.push({
        name: singleLine(person?.name) || singleLine(person?.address) || "(unnamed contact)",
        identifiers: [identifier],
        activity: [{
          date,
          path,
          anchor: messageAnchor(event),
          label: singleLine(event?.subject) || "(no subject)",
          channel: event.channel,
        }],
        updatedAt: String(event?.sentAt ?? ""),
      });
    }
  }
  return drafts;
}

function existingUpdatedAt(text) {
  const raw = /^updated:\s*(.+)$/m.exec(String(text ?? ""))?.[1]?.trim();
  if (!raw) return "";
  try {
    return String(JSON.parse(raw));
  } catch {
    return "";
  }
}

/**
 * Is this the text of a contact page *this package rendered*?
 *
 * A contact's key is `contactPathForDraft`'s answer, and its input is an
 * identifier a **sender** supplied — so the note already at that key is not
 * necessarily one this package wrote. `parseContactView` reads anything
 * without complaining (it is a lenient reader by design), which would turn
 * "merge into the page that is there" into "replace whatever is there", so
 * the frontmatter `type` the renderer always emits is what decides.
 *
 * False for anything unreadable as a contact page, ciphertext included — the
 * gateway's own rule that a note this pass cannot open is a note it must not
 * write, arriving here rather than being restated at each call site.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isContactNote(text) {
  const source = String(text ?? "");
  if (!source.startsWith("---\n")) return false;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return false;
  for (const line of source.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim() !== "type") continue;
    const raw = line.slice(colon + 1).trim();
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    return String(value) === CONTACT_TYPE;
  }
  return false;
}

/**
 * Merge one generated draft into an existing editable contact page and return
 * stable bytes, or `null` to leave the key alone — which is the answer
 * whenever the bytes there are not a contact page this package wrote.
 */
export function mergeContactNote(existingText, draft, options = {}) {
  if (existingText && !isContactNote(existingText)) return null;
  const existing = existingText ? parseContactView(existingText) : null;
  const merged = existing === null ? draft : mergeContacts(existing, draft);
  const path = contactPathForDraft(merged, options);
  if (path === null) return null;
  const slug = path.slice(path.lastIndexOf("/") + 1, -3);
  const updated = [existingUpdatedAt(existingText), String(draft?.updatedAt ?? "")]
    .filter(Boolean)
    .sort()
    .at(-1) ?? new Date(0).toISOString();
  return { path, text: renderContactNote({ ...merged, slug, now: updated }) };
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
    `type: ${JSON.stringify(CONTACT_TYPE)}`,
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

/** One `- kind: value` line under `## Identifiers`. */
const IDENTIFIER_LINE = /^-\s([a-z-]+):\s(.*)$/;

/** `### 2026-09` — one month heading under `## Activity`. */
const MONTH_HEADING = /^###\s(\d{4}-\d{2})\s*$/;

/** `- 2026-09-07 · email — [[path#anchor|label]]`, or without the `· channel`. */
const ACTIVITY_LINE = /^-\s(\d{4}-\d{2}-\d{2})(?:\s·\s([a-z-]+))?\s—\s(.*)$/;

/**
 * One `[[path#anchor|label]]` or `[[path|label]]`, as `activityLink` writes it.
 *
 * The label is `.*`, greedy, rather than `[^\]]*` — deliberately, because a
 * label is a stranger's subject run through `defangLinks` at write time, which
 * *breaks up* a `]]` it contains with a zero-width space rather than removing
 * it. So the label can still hold literal `]` characters, and only the
 * genuine closing `]]` this package wrote is ever an unbroken pair; matching
 * greedily to the last one in the line is what makes that safe to rely on
 * rather than a coincidence of the fixture.
 */
const WIKILINK = /^\[\[([^|#\]]+)(?:#([^|\]]+))?\|(.*)\]\]$/;

/**
 * Read a contact page back in full — the half a person can read (name,
 * organization, identifiers, disagreements) and the half this package
 * regenerates (activity, grouped the way `renderContactNote` grouped it) —
 * for a viewer rather than for the merge that only ever needed `## Notes`.
 *
 * Reuses `parseContactNote` for the notes half rather than a second reading
 * of the same heading, so the two can never disagree about where a person's
 * own writing starts.
 *
 * Every `label` here is exactly what `renderContactNote` wrote: a subject a
 * stranger chose, passed through `defangOutsideFence` at write time and never
 * un-escaped here — a viewer prints it as text and does not turn it back into
 * link syntax, for the reason `note.js`'s header on `defangLinks` argues in
 * full.
 *
 * @param {string} text
 * @returns {{
 *   name: string, organization: string,
 *   identifiers: Array<{kind: string, value: string}>,
 *   conflicts: string[],
 *   activity: Array<{date: string, channel: string, path: string, anchor: string, label: string}>,
 *   notes: string,
 * }}
 */
export function parseContactView(text) {
  const source = String(text ?? "");
  const name = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? "";
  const organization = /^\*\*Organization:\*\*\s(.+)$/m.exec(source)?.[1]?.trim() ?? "";

  const identifiers = [];
  const conflicts = [];
  const activity = [];

  const identifierStart = source.indexOf("\n## Identifiers");
  const conflictStart = source.indexOf("\n## Disagreements");
  const activityStart = source.indexOf(`\n${ACTIVITY_HEADING}`);
  const notesStart = source.indexOf(`\n${NOTES_HEADING}`);

  const sectionEnd = (start) => {
    if (start === -1) return -1;
    const candidates = [identifierStart, conflictStart, activityStart, notesStart, source.length]
      .filter((value) => value > start);
    return candidates.length ? Math.min(...candidates) : source.length;
  };

  if (identifierStart !== -1) {
    const section = source.slice(identifierStart, sectionEnd(identifierStart));
    for (const line of section.split("\n")) {
      const match = IDENTIFIER_LINE.exec(line);
      if (match) identifiers.push({ kind: match[1], value: match[2] });
    }
  }

  if (conflictStart !== -1) {
    const section = source.slice(conflictStart, sectionEnd(conflictStart));
    for (const line of section.split("\n")) {
      if (line.startsWith("- ")) conflicts.push(line.slice(2).trim());
    }
  }

  if (activityStart !== -1) {
    const section = source.slice(activityStart, sectionEnd(activityStart));
    let month = "";
    for (const line of section.split("\n")) {
      const monthMatch = MONTH_HEADING.exec(line);
      if (monthMatch) {
        month = monthMatch[1];
        continue;
      }
      const entryMatch = ACTIVITY_LINE.exec(line);
      if (!entryMatch) continue;
      const [, date, channel, rest] = entryMatch;
      const link = WIKILINK.exec(rest.trim());
      if (!link) continue;
      const [, path, anchor, label] = link;
      // The date on the line is authoritative; `month` is a display grouping
      // `renderContactNote` derives from the same date and is not read back —
      // a stray or missing heading must never change which day an entry is on.
      void month;
      activity.push({ date, channel: channel ?? "", path, anchor: anchor ?? "", label });
    }
  }

  return { name, organization, identifiers, conflicts, activity, notes: parseContactNote(source).notes ?? "" };
}
