/**
 * Scopes, rendered as sentences a person can actually weigh — and as the set of
 * choices they get to make.
 *
 * `context:read context:write` is a fact about our API. It is not an answer to
 * the question the consent screen exists to ask, which is "what will this thing
 * be able to do to my notes". So every scope we recognise gets a sentence in
 * the second person, and every scope we do not recognise gets said out loud as
 * unrecognised rather than quietly dropped or folded into a reassuring summary.
 *
 * Four rules this file exists to hold:
 *
 *  - **Never omit a scope.** A grant the screen did not mention is a grant the
 *    person did not consent to. An unknown scope renders as a line of its own,
 *    in the elevated tone, with the raw string visible.
 *  - **Never soften a wildcard.** `*` is not "read and write"; it is everything,
 *    including whatever we add next year. It says so.
 *  - **Never describe a grant as narrower than it is.** This one shipped wrong
 *    once: the read line promised "except notes you marked private" to
 *    *everybody*, which was exactly backwards for an owner — the default case,
 *    and the only person with private notes of their own to hand over.
 *  - **Never offer a control the backend will not honour.** A tick box that
 *    produces a refusal is worse than no tick box, so the options here are
 *    derived from the approver's role by the same rule
 *    `functions/lib/consentScopes.ts` clamps by. `__tests__/consentScopes.test.ts`
 *    imports that module and asserts the two agree, so the mirror is checked
 *    rather than asserted.
 *
 * ## What changed, and why the sentences can be honest now
 *
 * The privacy tier used to be derived from the approver's *role*, at request
 * time, in the gateway — so an owner always granted `private` and the screen
 * could only ever describe that, whatever it said. The tier is now a scope the
 * person chooses (`context:private`) and the grant records, which is what makes
 * "everything except notes marked private" a sentence we can put in front of an
 * owner without lying: if they picked team, that is what the grant carries and
 * what the gateway will enforce, forever.
 *
 * Pure and free of React so the vocabulary is pinned by tests rather than
 * discovered by reading a screenshot.
 */

/** The scope that carries the privacy tier. Canonical spelling. */
export const SCOPE_PRIVATE = "context:private";

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
 * How much of a context a grant reaches.
 *
 * `unknown` is not a tier the gateway has; it is this screen admitting it does
 * not yet know which context is being granted — which happens for real, when
 * someone with several contexts has not picked one. It gets its own sentence
 * rather than borrowing either of the others, because both of those would be a
 * claim we cannot make.
 */
export type VisibilityTier = "private" | "team" | "unknown";

/** A tier a person can actually pick. `unknown` is a state, not a choice. */
export type GrantableTier = "private" | "team";

/**
 * The widest tier this role could hand over.
 *
 * Only an `owner` may grant `private`. An `editor` can write and a `member`
 * cannot, but neither of them is the person whose private notes these are —
 * they cannot read one themselves, so they certainly cannot delegate reading
 * one. A role we do not recognise yields `unknown`, which offers nothing.
 *
 * Note what this is *not*: it is no longer "the tier this approver's grant
 * gets". That used to be the same function, and it was the bug. This only says
 * what may be offered; what is granted is what the person picked.
 */
export function tierCeilingForRole(role: string | null | undefined): VisibilityTier {
  if (role === "owner") return "private";
  if (role === "editor" || role === "member") return "team";
  return "unknown";
}

/**
 * Which tiers to draw as choices, widest last.
 *
 * A single-entry list means there is no decision to make — the screen states
 * the tier rather than asking about it, because a radio group with one option
 * is a control that pretends the person chose.
 */
export function grantableTiers(role: string | null | undefined): GrantableTier[] {
  return tierCeilingForRole(role) === "private" ? ["team", "private"] : ["team"];
}

/**
 * Whether this role could hand over the operation named by a scope.
 *
 * Mirrors `clampScopes` in `functions/lib/consentScopes.ts`: `member` is
 * read-only, `editor` and `owner` may write, and the tier scope is the owner's
 * alone. Anything this file has no opinion about is left to the backend — the
 * screen shows it, the person may tick it, and the clamp there decides.
 */
export function roleCanGrantScope(role: string | null | undefined, scope: string): boolean {
  if (WRITE_SCOPES.has(scope)) return role === "owner" || role === "editor";
  if (PRIVATE_TIER_SCOPES.has(scope)) return role === "owner";
  return true;
}

/** Canonical spellings the gateway honours as authority to change notes. */
const WRITE_SCOPES: ReadonlySet<string> = new Set(["context:write", "context:capture"]);

/** Every spelling anything here reads as "reaches private notes". */
const PRIVATE_TIER_SCOPES: ReadonlySet<string> = new Set([
  SCOPE_PRIVATE,
  "context.private",
  "private",
  "*",
  "context:*",
  "context.*",
  "all",
]);

/**
 * Is this scope the tier rather than an operation?
 *
 * The screen splits the request in two: operations get tick boxes, the tier
 * gets its own control. Folding the tier into the tick boxes would put "how
 * much of my context does this see" in a list of things a client can *do*,
 * which is the framing that made it invisible in the first place.
 */
export function isTierScope(scope: string): boolean {
  return PRIVATE_TIER_SCOPES.has(scope);
}

/**
 * "Read your notes", said honestly for the tier actually being granted.
 *
 * The three sentences are the whole point of this file, so they are here
 * together where they can be compared rather than scattered through a
 * conditional.
 */
function readLine(tier: VisibilityTier): ScopeLine {
  switch (tier) {
    case "private":
      // Not "the owner case" any more — the case where the person chose to hand
      // over their private notes. Saying "except notes you marked private" here
      // would be false.
      return {
        id: "read",
        sentence: "Read your notes",
        detail:
          "Every note in this context, including the ones you marked private — this client reads it exactly as you do.",
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
          "Everything this connection's privacy setting reaches. Pick a context to see which notes that is.",
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
 * An entry is either a fixed line or a function of the tier being granted, for
 * the scopes whose meaning genuinely depends on how much of the context is on
 * the table.
 */
type ScopeEntry = ScopeLine | ((tier: VisibilityTier) => ScopeLine);

const SCOPE_ALIASES: ReadonlyArray<[readonly string[], ScopeEntry]> = [
  [["read", "context:read", "context.read", "notes:read"], readLine],
  [
    // Officially supported and advertised in both discovery documents
    // (`SUPPORTED_SCOPES` in apps/mcp/src/session.js), and `/oauth/authorize`
    // rejects anything outside that set. Without an entry here it fell to the
    // unknown-scope fallback, so a client asking for exactly what the server
    // advertises was shown a red "this version of Context can't describe it —
    // approve only if you know what this client is asking for". The one scope
    // guaranteed to appear was the one the screen called suspicious.
    ["capture", "context:capture", "context.capture", "notes:capture"],
    {
      id: "capture",
      sentence: "File things into your inbox",
      detail:
        "Add captures to 0-inbox/, the same way forwarded email arrives. It cannot read or change anything already in your context.",
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
    ["capture", "context:capture", "context.capture"],
    {
      id: "capture",
      sentence: "Drop things into your inbox",
      detail: "New notes in 0-inbox, and nothing else touched.",
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
 * One scope's sentence, at the tier being granted.
 *
 * Exported because the screen draws a tick box per requested scope and needs
 * the line for exactly that scope, keyed by the raw string. An unrecognised
 * scope still gets a line saying so — the tick box is drawn, and it says we
 * cannot describe what ticking it means.
 */
export function scopeLine(scope: string, tier: VisibilityTier): ScopeLine {
  if (WILDCARDS.has(scope)) return WILDCARD_LINE;
  const entry = BY_ALIAS.get(scope);
  if (entry === undefined) {
    return {
      id: `unknown:${scope}`,
      sentence: `Something this version of Context can't describe: ${scope}`,
      detail: "Approve only if you know what this client is asking for.",
      tone: "unknown",
    };
  }
  return typeof entry === "function" ? entry(tier) : entry;
}

/**
 * The sentences to show, in the order they should be read.
 *
 * A wildcard collapses the list, because enumerating six lines under a grant
 * that already covers everything reads as if the six were the limit. Otherwise
 * lines keep the order the scopes arrived in, deduplicated by meaning — asking
 * for both `read` and `context:read` should not print the same sentence twice.
 *
 * `tier` is how much of the context this approval would hand over — the
 * person's own choice, not their role. It is required rather than optional: the
 * sentences are claims about what this approval exposes, and a caller that has
 * not thought about which tier is being granted should be made to pass
 * `"unknown"` and get the sentence that says so.
 */
export function scopeSentences(
  scopes: string | readonly string[] | null | undefined,
  tier: VisibilityTier,
): ScopeLine[] {
  const normalized = normalizeScopes(scopes);
  if (normalized.length === 0) return [];
  if (normalized.some((scope) => WILDCARDS.has(scope))) return [WILDCARD_LINE];

  const lines: ScopeLine[] = [];
  const seen = new Set<string>();
  for (const scope of normalized) {
    const line = scopeLine(scope, tier);
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

/** The tier control's two options, as the screen renders them. */
export function tierOption(tier: GrantableTier): { label: string; detail: string } {
  return tier === "private"
    ? {
        label: "Everything, including private notes",
        detail:
          "This client reads your context exactly as you do — every note, including the ones you marked private.",
      }
    : {
        label: "Team notes only",
        detail:
          "Anything you marked private stays invisible to this client. Notes shared with people you named are readable.",
      };
}
