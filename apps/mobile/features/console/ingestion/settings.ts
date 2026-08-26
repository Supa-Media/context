/**
 * Email ingestion: where forwarded mail lands, and who is allowed to send it.
 *
 * Both halves used to be fixed — the address was presented as immutable and
 * everything it received went to `0-inbox/`. Neither is safe as a permanent
 * default:
 *
 *  - The address is **semi-public**. It ends up in a forwarding rule, a mailing
 *    list, a screenshot. Anyone who learns it can post into someone's context
 *    unless there is a list saying who may. So the allow-list is the security
 *    control, and "anyone" has to be a thing you deliberately turn on, in
 *    words, rather than the state you get by not deciding.
 *  - The folder is a filing preference. `0-inbox/` is the right default under
 *    PARA, and it is nobody's business but the owner's if it should be
 *    `2-areas/receipts/` instead.
 *
 * Everything here is pure so the awkward cases — a typo'd domain, a folder
 * spelled with a leading slash, a list that would allow the whole internet
 * without saying so — are pinned by tests rather than found in production.
 * The backend validates all of it again; this layer exists so somebody finds
 * out before the round trip.
 */

/** The shape `getIngestionSettings` returns. Mirrors the backend contract. */
export interface IngestionSettings {
  /** The alias mail is forwarded to. Issued by the control plane, not editable. */
  address: string;
  /** Bucket-relative, with a trailing slash. `0-inbox/` by default. */
  targetFolder: string;
  /** Exact addresses that may send. */
  allowedSenders: string[];
  /** Whole domains that may send, without the `@`. */
  allowedDomains: string[];
  /** Turns the address into an open drop-box. Deliberately explicit. */
  allowAnySender: boolean;
}

/** The editable half. `address` is issued, not chosen. */
export type IngestionDraft = Omit<IngestionSettings, "address">;

/** The patch `updateIngestionSettings` takes — only what actually changed. */
export interface IngestionPatch {
  targetFolder?: string;
  allowedSenders?: string[];
  allowedDomains?: string[];
  allowAnySender?: boolean;
}

/**
 * What the settings card is handed.
 *
 * Declared here, in the pure module, rather than beside the Convex hook: the
 * landing page builds one of these from literals with no backend at all, and
 * `ConsoleData` must not drag `convex/react` into every module that mentions
 * it.
 *
 * `save` is **absent**, not disabled, for anyone who cannot use it — the demo,
 * and any non-owner. Same rule as `StorageActions`: a control that is never
 * offered cannot mislead.
 */
export interface IngestionState {
  /** The stored settings, or `null` while loading or when none are issued. */
  settings: IngestionSettings | null;
  loading: boolean;
  /** False when this deployment has no ingestion functions at all. */
  available: boolean;
  save?: (patch: IngestionPatch) => Promise<void>;
}

/** What a console with no ingestion backend behind it shows. */
export const UNAVAILABLE_INGESTION: IngestionState = {
  settings: null,
  loading: false,
  available: false,
};

export const DEFAULT_TARGET_FOLDER = "0-inbox/";

/**
 * The backend's limits, mirrored so the console refuses before the round trip.
 *
 * These are `MAX_FOLDER_LENGTH`, `MAX_ALLOWED_SENDERS` and
 * `MAX_ALLOWED_DOMAINS` in `apps/convex/functions/lib/ingestion.ts`. The
 * backend enforces them for real and throws a `ConvexError` naming the limit;
 * duplicating them here buys a message that arrives while somebody is still
 * typing, not one that arrives after a save appears to have started.
 */
export const MAX_FOLDER_LENGTH = 512;
export const MAX_ALLOWED_SENDERS = 50;
export const MAX_ALLOWED_DOMAINS = 20;

export function emptyDraft(): IngestionDraft {
  return {
    targetFolder: DEFAULT_TARGET_FOLDER,
    allowedSenders: [],
    allowedDomains: [],
    allowAnySender: false,
  };
}

export function draftOf(settings: IngestionSettings): IngestionDraft {
  return {
    targetFolder: settings.targetFolder,
    allowedSenders: [...settings.allowedSenders],
    allowedDomains: [...settings.allowedDomains],
    allowAnySender: settings.allowAnySender,
  };
}

// ─── the target folder ───────────────────────────────────────────────────────

/**
 * `0-inbox`, `/0-inbox/`, ` 0-inbox ` → `0-inbox/`.
 *
 * The canonical form the backend stores: no leading slash, no duplicate
 * slashes, exactly one trailing slash. The slash is load-bearing rather than
 * cosmetic — the receiver appends a generated filename, and `0-inbox` without
 * it concatenates to `0-inboxmessage.md`.
 *
 * The console normalises rather than refuses: somebody typing the path they can
 * see in Obsidian is not making a mistake. It mirrors `normalizeTargetFolder`
 * in `apps/convex/functions/lib/ingestion.ts`, which is the one that counts.
 */
export function normaliseFolder(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  return collapsed === "" ? "" : `${collapsed}/`;
}

/** Why this folder will not work, or `null`. */
export function describeFolderProblem(raw: string): string | null {
  const folder = normaliseFolder(raw);
  if (folder === "") return "Pick a folder. Mail has to land somewhere.";
  const segments = folder.slice(0, -1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return "That is not a folder path. Use names separated by single slashes.";
    }
    if (segment.trim() === "" || segment !== segment.trim()) {
      // A segment padded with spaces is a key S3 will happily store and nobody
      // can ever type again. The backend refuses it; so does this.
      return "That folder path has a space at the start or end of a name.";
    }
    if (segment.startsWith(".")) {
      return "Folders starting with a dot are reserved for history and audit files.";
    }
    // Control characters and the backslash some backends fold to "/" — the
    // same set the file editor refuses in `describeNameProblem`.
    if (/[\u0000-\u001f\u007f\\]/.test(segment)) {
      return "That folder name contains a character a bucket cannot store.";
    }
  }
  if (folder.length > MAX_FOLDER_LENGTH) {
    return `A folder path must be at most ${MAX_FOLDER_LENGTH} characters.`;
  }
  return null;
}

// ─── who may send ────────────────────────────────────────────────────────────

export type SenderEntry =
  | { kind: "email"; value: string }
  | { kind: "domain"; value: string };

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * What somebody typed into the "who may send" box.
 *
 * Three spellings all mean the domain: `publicworship.life`, `@publicworship.life`,
 * and `*@publicworship.life`. That is not laxity — a person who wants "anyone at
 * work" will reach for whichever of those they have seen elsewhere, and refusing
 * two of the three teaches nothing.
 */
export function parseSenderEntry(raw: string): SenderEntry | { problem: string } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return { problem: "Type an address or a domain." };

  const wildcard = trimmed.replace(/^\*?@/, "");
  const wasDomainForm = wildcard !== trimmed;

  if (!wasDomainForm && EMAIL.test(trimmed)) {
    return { kind: "email", value: trimmed };
  }
  if (DOMAIN.test(wildcard)) {
    return { kind: "domain", value: wildcard };
  }
  if (trimmed.includes("@")) {
    return { problem: "That does not look like an email address." };
  }
  return {
    problem:
      "Type a whole address (someone@example.com) or a domain (example.com) to allow everyone there.",
  };
}

/**
 * The refusal branch of anything in this module that can refuse.
 *
 * Generic on purpose: `parseSenderEntry` and `addSender` return different
 * successes and the same failure, and two identical guards would be two places
 * to forget.
 */
export function isSenderProblem<T extends object>(
  result: T | { problem: string },
): result is { problem: string } {
  return "problem" in result;
}

/** Whether this entry is already on the list — case-insensitively. */
export function alreadyAllowed(draft: IngestionDraft, entry: SenderEntry): boolean {
  const list = entry.kind === "email" ? draft.allowedSenders : draft.allowedDomains;
  return list.some((value) => value.toLowerCase() === entry.value);
}

/**
 * Adds an entry, keeping each list sorted and free of duplicates.
 *
 * An address whose domain is already allowed is refused rather than silently
 * added: a list that says both "@publicworship.life" and "seyi@publicworship.life"
 * reads as if the second line does something, and it does not.
 */
export function addSender(
  draft: IngestionDraft,
  raw: string,
): { draft: IngestionDraft } | { problem: string } {
  const parsed = parseSenderEntry(raw);
  if (isSenderProblem(parsed)) return parsed;
  if (alreadyAllowed(draft, parsed)) return { problem: "That is already on the list." };

  if (parsed.kind === "email") {
    const domain = parsed.value.slice(parsed.value.indexOf("@") + 1);
    if (draft.allowedDomains.some((value) => value.toLowerCase() === domain)) {
      return { problem: `Everyone at ${domain} is already allowed.` };
    }
    if (draft.allowedSenders.length >= MAX_ALLOWED_SENDERS) {
      return {
        problem: `You can allow at most ${MAX_ALLOWED_SENDERS} individual addresses. Allow a whole domain instead.`,
      };
    }
    return {
      draft: { ...draft, allowedSenders: sorted([...draft.allowedSenders, parsed.value]) },
    };
  }

  if (draft.allowedDomains.length >= MAX_ALLOWED_DOMAINS) {
    return { problem: `You can allow at most ${MAX_ALLOWED_DOMAINS} domains.` };
  }

  // Adding a domain absorbs the individual addresses it covers, so the list
  // never shows a line that has stopped meaning anything.
  return {
    draft: {
      ...draft,
      allowedDomains: sorted([...draft.allowedDomains, parsed.value]),
      allowedSenders: draft.allowedSenders.filter(
        (value) => value.slice(value.indexOf("@") + 1).toLowerCase() !== parsed.value,
      ),
    },
  };
}

export function removeSender(draft: IngestionDraft, entry: SenderEntry): IngestionDraft {
  if (entry.kind === "email") {
    return {
      ...draft,
      allowedSenders: draft.allowedSenders.filter(
        (value) => value.toLowerCase() !== entry.value.toLowerCase(),
      ),
    };
  }
  return {
    ...draft,
    allowedDomains: draft.allowedDomains.filter(
      (value) => value.toLowerCase() !== entry.value.toLowerCase(),
    ),
  };
}

/** Every allowed sender, domains first, for rendering as one list of chips. */
export function senderEntries(draft: IngestionDraft): SenderEntry[] {
  return [
    ...draft.allowedDomains.map((value): SenderEntry => ({ kind: "domain", value })),
    ...draft.allowedSenders.map((value): SenderEntry => ({ kind: "email", value })),
  ];
}

export function senderLabel(entry: SenderEntry): string {
  return entry.kind === "domain" ? `anyone @${entry.value}` : entry.value;
}

/**
 * What the current rules actually mean, in one sentence.
 *
 * The empty list is the case worth being loud about: no rule and no "anyone"
 * is a closed door, not an open one, and somebody who forwarded mail and saw
 * nothing arrive deserves to be told which of the two it was.
 */
export function describeSenderPolicy(draft: IngestionDraft): {
  tone: "ok" | "warn" | "crit";
  text: string;
} {
  if (draft.allowAnySender) {
    return {
      tone: "crit",
      text: "Anyone who learns this address can put a note in this context. Nothing is checked.",
    };
  }
  const entries = senderEntries(draft);
  if (entries.length === 0) {
    return {
      tone: "warn",
      text: "Nobody is allowed to send yet, so mail to this address is dropped. Add an address or a domain.",
    };
  }
  const domains = draft.allowedDomains.length;
  const addresses = draft.allowedSenders.length;
  const parts: string[] = [];
  if (addresses > 0) parts.push(`${addresses} address${addresses === 1 ? "" : "es"}`);
  if (domains > 0) parts.push(`${domains} domain${domains === 1 ? "" : "s"}`);
  return { tone: "ok", text: `Mail is accepted from ${parts.join(" and ")}. Everything else is dropped.` };
}

// ─── saving ──────────────────────────────────────────────────────────────────

/** True when the draft says something different from what is stored. */
export function isDirty(draft: IngestionDraft, saved: IngestionDraft): boolean {
  return Object.keys(diff(draft, saved)).length > 0;
}

/**
 * Only what changed.
 *
 * `updateIngestionSettings` takes every field as optional, so sending the whole
 * draft back would have two consoles open on the same context overwrite each
 * other's unrelated edits.
 */
export function diff(draft: IngestionDraft, saved: IngestionDraft): IngestionPatch {
  const patch: IngestionPatch = {};
  if (normaliseFolder(draft.targetFolder) !== normaliseFolder(saved.targetFolder)) {
    patch.targetFolder = normaliseFolder(draft.targetFolder);
  }
  if (!sameList(draft.allowedSenders, saved.allowedSenders)) {
    patch.allowedSenders = sorted(draft.allowedSenders);
  }
  if (!sameList(draft.allowedDomains, saved.allowedDomains)) {
    patch.allowedDomains = sorted(draft.allowedDomains);
  }
  if (draft.allowAnySender !== saved.allowAnySender) {
    patch.allowAnySender = draft.allowAnySender;
  }
  return patch;
}

/** Why this draft cannot be saved, or `null`. */
export function describeDraftProblem(draft: IngestionDraft): string | null {
  return describeFolderProblem(draft.targetFolder);
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
