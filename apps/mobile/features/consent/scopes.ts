/**
 * Scopes, rendered as sentences a person can actually weigh.
 *
 * `context:read context:write` is a fact about our API. It is not an answer to
 * the question the consent screen exists to ask, which is "what will this thing
 * be able to do to my notes". So every scope we recognise gets a sentence in
 * the second person, and every scope we do not recognise gets said out loud as
 * unrecognised rather than quietly dropped or folded into a reassuring summary.
 *
 * Three rules this file exists to hold:
 *
 *  - **Never omit a scope.** A grant the screen did not mention is a grant the
 *    person did not consent to. An unknown scope renders as a line of its own,
 *    in the elevated tone, with the raw string visible.
 *  - **Never soften a wildcard.** `*` is not "read and write"; it is everything,
 *    including whatever we add next year. It says so.
 *  - **Never describe a grant as narrower than the approver's own role makes
 *    it.** `context:read` does not reach the same notes for everybody — the
 *    gateway derives the privacy tier from the approver's membership role, not
 *    from the scope string (`visibilityTierForRole`). This one shipped wrong:
 *    the read line promised "except notes you marked private" to *everybody*,
 *    which is exactly backwards for an owner — the default case, and the only
 *    person with private notes of their own to hand over.
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
 * How much of a context a grant reaches, as the gateway decides it.
 *
 * `unknown` is not a tier the gateway has; it is this screen admitting it does
 * not yet know which context is being granted — which happens for real, when
 * someone with several contexts has not picked one. It gets its own sentence
 * rather than borrowing either of the others, because both of those would be a
 * claim we cannot make.
 */
export type VisibilityTier = "private" | "team" | "unknown";

/**
 * Membership role → privacy tier.
 *
 * A mirror of `visibilityTierForRole` in `apps/mcp/src/session.js`, which is
 * what actually runs: `owner` resolves to the `private` tier, and
 * `privacy.ts`'s `canSee` returns `true` for every note at that tier —
 * exceptions included. An `editor` can write and a `member` cannot, but neither
 * of them is the person whose private notes these are, so both resolve to
 * `team` and genuinely cannot read a private note.
 *
 * Duplicating the mapping in the UI is deliberate. The alternative is a
 * consent screen that cannot say what it is granting without another round
 * trip, and a screen that guesses is the bug this exists to prevent. If the
 * gateway's mapping changes, this must change with it — the sentences below
 * are the user-facing statement of that one function.
 */
export function visibilityTierForRole(role: string | null | undefined): VisibilityTier {
  if (role === "owner") return "private";
  if (role === "editor" || role === "member") return "team";
  return "unknown";
}

/**
 * "Read your notes", said honestly for whoever is approving.
 *
 * The three sentences are the whole point of this file, so they are here
 * together where they can be compared rather than scattered through a
 * conditional.
 */
function readLine(tier: VisibilityTier): ScopeLine {
  switch (tier) {
    case "private":
      // The owner case, and the default one. Saying "except notes you marked
      // private" here would be false: an owner's grant carries the owner's own
      // tier, and every private note comes with it.
      return {
        id: "read",
        sentence: "Read your notes",
        detail:
          "Every note in this context, including the ones you marked private — you own it, so this client reads it exactly as you do.",
        tone: "elevated",
      };
    case "team":
      return {
        id: "read",
        sentence: "Read your notes",
        detail: "Everything in this context except notes marked private.",
        tone: "plain",
      };
    case "unknown":
      return {
        id: "read",
        sentence: "Read your notes",
        detail:
          "Everything in this context. If you own it, that includes the notes you marked private.",
        tone: "elevated",
      };
  }
}

/**
 * The vocabulary.
 *
 * The gateway's scope names are not frozen — `format.ts` already carries three
 * spellings of the same idea (`private`, `context:private`, `context.private`)
 * because different parts of the system arrived at different separators. Rather
 * than pick a winner the UI cannot enforce, every alias maps to one entry here.
 *
 * An entry is either a fixed line or a function of the approver's tier, for the
 * scopes whose meaning genuinely depends on who is approving.
 */
type ScopeEntry = ScopeLine | ((tier: VisibilityTier) => ScopeLine);

const SCOPE_ALIASES: ReadonlyArray<[readonly string[], ScopeEntry]> = [
  [["read", "context:read", "context.read", "notes:read"], readLine],
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

const BY_ALIAS = new Map<string, ScopeEntry>();
for (const [aliases, entry] of SCOPE_ALIASES) {
  for (const alias of aliases) BY_ALIAS.set(alias, entry);
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
 *
 * `role` is the approver's membership role **in the context they are about to
 * grant**, not in some other one. It is required rather than optional: the
 * sentences are claims about what this approval exposes, and a caller that has
 * not thought about whose approval it is should be made to pass `null` and get
 * the sentence that says so.
 */
export function scopeSentences(
  scopes: string | readonly string[] | null | undefined,
  role: string | null | undefined,
): ScopeLine[] {
  const normalized = normalizeScopes(scopes);
  if (normalized.length === 0) return [];
  if (normalized.some((scope) => WILDCARDS.has(scope))) return [WILDCARD_LINE];

  const tier = visibilityTierForRole(role);
  const lines: ScopeLine[] = [];
  const seen = new Set<string>();
  for (const scope of normalized) {
    const entry = BY_ALIAS.get(scope);
    const known = typeof entry === "function" ? entry(tier) : entry;
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
