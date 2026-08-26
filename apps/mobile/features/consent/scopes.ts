/**
 * Scopes, rendered as sentences a person can actually weigh.
 *
 * `context:read context:write` is a fact about our API. It is not an answer to
 * the question the consent screen exists to ask, which is "what will this thing
 * be able to do to my notes". So every scope we recognise gets a sentence in
 * the second person, and every scope we do not recognise gets said out loud as
 * unrecognised rather than quietly dropped or folded into a reassuring summary.
 *
 * Two rules this file exists to hold:
 *
 *  - **Never omit a scope.** A grant the screen did not mention is a grant the
 *    person did not consent to. An unknown scope renders as a line of its own,
 *    in the elevated tone, with the raw string visible.
 *  - **Never soften a wildcard.** `*` is not "read and write"; it is everything,
 *    including whatever we add next year. It says so.
 *
 * Pure and free of React so the vocabulary is pinned by tests rather than
 * discovered by reading a screenshot.
 */

/** How loudly a line should read. */
export type ScopeTone =
  /** Ordinary read access. */
  | "plain"
  /** Changes or removes the customer's notes, or reaches private ones. */
  | "elevated"
  /** We cannot say what this grants. */
  | "unknown";

export interface ScopeLine {
  /** Stable key for rendering, and what the tests assert on. */
  id: string;
  /** The sentence. Second person, present tense, no jargon. */
  sentence: string;
  /** One clarifying clause, where the sentence alone would mislead. */
  detail?: string;
  tone: ScopeTone;
}

/**
 * The vocabulary.
 *
 * The gateway's scope names are not frozen — `format.ts` already carries three
 * spellings of the same idea (`private`, `context:private`, `context.private`)
 * because different parts of the system arrived at different separators. Rather
 * than pick a winner the UI cannot enforce, every alias maps to one entry here.
 */
const SCOPE_ALIASES: ReadonlyArray<[readonly string[], ScopeLine]> = [
  [
    ["read", "context:read", "context.read", "notes:read"],
    {
      id: "read",
      sentence: "Read your notes",
      detail: "Everything in this context except notes you marked private.",
      tone: "plain",
    },
  ],
  [
    ["write", "context:write", "context.write", "notes:write"],
    {
      id: "write",
      sentence: "Create and edit notes",
      detail: "New files, and changes to existing ones, written into your bucket.",
      tone: "elevated",
    },
  ],
  [
    ["delete", "context:delete", "context.delete", "notes:delete"],
    {
      id: "delete",
      sentence: "Delete notes",
      detail: "Removed from your bucket. Recoverable only if your provider keeps versions.",
      tone: "elevated",
    },
  ],
  [
    ["search", "context:search", "context.search"],
    {
      id: "search",
      sentence: "Search across your context",
      tone: "plain",
    },
  ],
  [
    ["attachments", "context:attachments", "context.attachments"],
    {
      id: "attachments",
      sentence: "Read and write attachments",
      detail: "Images and files stored alongside your notes.",
      tone: "elevated",
    },
  ],
  [
    ["private", "context:private", "context.private"],
    {
      id: "private",
      sentence: "Reach notes you marked private",
      detail: "Without this, anything private in your manifest stays invisible to this client.",
      tone: "elevated",
    },
  ],
  [
    ["team", "context:team", "context.team"],
    {
      id: "team",
      sentence: "Reach notes shared with people you named",
      detail: "Your private notes stay invisible to this client.",
      tone: "plain",
    },
  ],
  [
    ["audit", "context:audit", "context.audit"],
    {
      id: "audit",
      sentence: "Read your access history",
      tone: "plain",
    },
  ],
  [
    ["offline_access", "offline"],
    {
      id: "offline_access",
      sentence: "Stay connected without asking you again",
      detail: "You can end this at any time from Connections.",
      tone: "plain",
    },
  ],
  [
    ["openid", "profile", "email"],
    {
      id: "identity",
      sentence: "See which account you are",
      detail: "Your email address and nothing else.",
      tone: "plain",
    },
  ],
];

const BY_ALIAS = new Map<string, ScopeLine>();
for (const [aliases, line] of SCOPE_ALIASES) {
  for (const alias of aliases) BY_ALIAS.set(alias, line);
}

const WILDCARDS = new Set(["*", "context:*", "context.*", "all"]);

const WILDCARD_LINE: ScopeLine = {
  id: "wildcard",
  sentence: "Do anything in this context",
  detail:
    "Read, write, and delete every note — private ones included — plus anything Context adds later.",
  tone: "elevated",
};

/**
 * Split whatever the backend hands back into scope strings.
 *
 * OAuth carries `scope` as one space-delimited string; our own query has at
 * times returned an array. Accept both rather than making the screen guess.
 */
export function normalizeScopes(scopes: string | readonly string[] | null | undefined): string[] {
  if (scopes === null || scopes === undefined) return [];
  const parts = typeof scopes === "string" ? scopes.split(/[\s,]+/) : scopes;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * The sentences to show, in the order they should be read.
 *
 * A wildcard collapses the list, because enumerating six lines under a grant
 * that already covers everything reads as if the six were the limit. Otherwise
 * lines keep the order the scopes arrived in, deduplicated by meaning — asking
 * for both `read` and `context:read` should not print the same sentence twice.
 */
export function scopeSentences(
  scopes: string | readonly string[] | null | undefined,
): ScopeLine[] {
  const normalized = normalizeScopes(scopes);
  if (normalized.length === 0) return [];
  if (normalized.some((scope) => WILDCARDS.has(scope))) return [WILDCARD_LINE];

  const lines: ScopeLine[] = [];
  const seen = new Set<string>();
  for (const scope of normalized) {
    const known = BY_ALIAS.get(scope);
    const line: ScopeLine = known ?? {
      id: `unknown:${scope}`,
      sentence: `Something this version of Context can't describe: ${scope}`,
      detail: "Approve only if you know what this client is asking for.",
      tone: "unknown",
    };
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    lines.push(line);
  }
  return lines;
}

/**
 * Whether any line is beyond plain reading.
 *
 * Used to decide whether the screen says the quiet thing ("it will be able to
 * read…") or the loud one ("it will be able to change your notes").
 */
export function hasElevatedScope(lines: readonly ScopeLine[]): boolean {
  return lines.some((line) => line.tone !== "plain");
}
