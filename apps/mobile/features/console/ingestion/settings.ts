/**
 * Email ingestion: where forwarded mail lands, and who is allowed to send it.
 *
 * Both halves used to be fixed — the address was presented as immutable and
 * everything it received went to `0-inbox/`. Neither is safe as a permanent
 * default:
 *
 *  - The address is **semi-public**. It ends up in a forwarding rule, a mailing
 *    list, a screenshot. Anyone who learns it can post into someone's context
 *    unless there is a list saying who may. So the allow-list is worth having,
 *    and "anyone" has to be a thing you deliberately turn on, in words, rather
 *    than the state you get by not deciding.
 *  - The folder is a filing preference. `0-inbox/` is the right default under
 *    PARA, and it is nobody's business but the owner's if it should be
 *    `2-areas/receipts/` instead.
 *
 * And there is a third thing that used to be presented as universal and is not:
 * **which contexts have an address at all.** Only a personal one does. See
 * `IngestionAvailability` below, and the header of
 * `apps/convex/functions/lib/ingestionStore.ts` for the reasoning.
 *
 * ============================================================================
 * THE ALLOW-LIST FILTERS. IT DOES NOT AUTHENTICATE.
 * ============================================================================
 *
 * This file used to call it "the security control", and the card called it the
 * same. That is no longer true and the copy had to be rewritten for it.
 *
 * The receiver used to refuse any message whose sender's domain it could not
 * verify. It does not any more — see the "authentication is a label, not a
 * gate" block in `infra/email-worker/src/auth.ts` for the two real deliveries
 * that settled it. An inbox is expected to contain unverified mail, and every
 * capture is fenced as untrusted input whoever it came from.
 *
 * So the list decides *whether* a message is captured, and nothing else. A
 * sender who knows one address on it can put that address in `From:` and pass.
 * What the list actually buys is that the ordinary internet — anyone who learns
 * the address but not who is on the list — gets nothing, which is real and
 * worth configuring. What it does not buy is any assurance that a captured note
 * came from who it says.
 *
 * Every sentence here that describes the list has to leave the reader with that
 * distinction, and none may imply a boundary. `__tests__/captureHonesty.test.ts`
 * bans the vocabulary — "nobody else", "verified sender", "we check who sent
 * it" — the way it already bans present-tense delivery claims, so a sentence
 * added later is caught without anybody remembering this paragraph.
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
  /**
   * Whether anything is actually accepting mail at `address`.
   *
   * **Optional, and its absence is not a `true`.** A control plane that
   * predates this field says nothing, and a console that read "nothing" as
   * "yes" is precisely the bug this field exists to make impossible. Same
   * treatment as the storage facts the capability probe has not persisted: an
   * absent fact is not drawn.
   *
   * Nothing in the UI may read this directly — go through `receivesMail`,
   * which is the single place allowed to conclude that mail lands anywhere.
   */
  receiving?: boolean;
  /** Bucket-relative, with a trailing slash. `0-inbox/` by default. */
  targetFolder: string;
  /** Exact addresses that may send. */
  allowedSenders: string[];
  /** Whole domains that may send, without the `@`. */
  allowedDomains: string[];
  /** Turns the address into an open drop-box. Deliberately explicit. */
  allowAnySender: boolean;
}

/**
 * The editable half.
 *
 * `address` is issued, not chosen, and `receiving` is a fact about the
 * deployment rather than a setting — neither belongs in something a Save
 * button sends.
 */
export type IngestionDraft = Omit<IngestionSettings, "address" | "receiving">;

/** The patch `updateIngestionSettings` takes — only what actually changed. */
export interface IngestionPatch {
  targetFolder?: string;
  allowedSenders?: string[];
  allowedDomains?: string[];
  allowAnySender?: boolean;
}

/**
 * Whether this context has a capture address at all.
 *
 * Not a setting, and this is the distinction the whole card turns on. **Only a
 * personal context receives email** — see the header of
 * `apps/convex/functions/lib/ingestionStore.ts`, which is the reasoning: inbound
 * mail is unauthenticated by nature, and writing into a space several people
 * read is a different risk from writing into your own. A shared context has no
 * address. Not a disabled one, not one awaiting configuration.
 *
 * So `"no-address"` is not "off". Off is a personal context whose owner has not
 * said who may send yet, and they can change that this afternoon. `"no-address"`
 * is a fact about the kind of context, and there is no form that would change
 * it — which is exactly why the card must not draw one.
 */
export type IngestionAvailability = "available" | "no-address";

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
  /** The stored settings, or `null` while loading, and always when unavailable. */
  settings: IngestionSettings | null;
  loading: boolean;
  /** Whether a capture address exists here at all. See `IngestionAvailability`. */
  availability: IngestionAvailability;
  save?: (patch: IngestionPatch) => Promise<void>;
}

/**
 * Does mail sent to this context's capture address land anywhere?
 *
 * **The single gate on every sentence in this product that says mail lands, is
 * accepted, or is dropped.** Written as one function, exported from the pure
 * module, so that "may I claim delivery here?" has exactly one answer and one
 * place to change it.
 *
 * ### It is two questions, and delivery needs a yes to both
 *
 * They were found separately and they are genuinely separate:
 *
 *  - **Is a receiver live at all?** A property of the *deployment*, which only
 *    the control plane can see. It arrives as `receiving` on the settings
 *    contract, from `ingestionIsReceiving()` in
 *    `apps/convex/functions/lib/ingestion.ts`, and it is false by absence.
 *  - **May *this* context receive mail?** A property of the *context*. Only a
 *    personal one has a capture address at all — see `IngestionAvailability`
 *    and `resolvePersonalContextForIngestion` on the backend.
 *
 * A live receiver does not give a shared context an inbox, and a personal
 * context does not conjure a receiver. So this is an `&&`, not a pick, and the
 * `availability` half is checked explicitly rather than left to lean on the
 * fact that a `no-address` state also happens to carry `settings === null`
 * today. That coincidence is an invariant three modules maintain by hand
 * (`NO_INGESTION_ADDRESS`, `shouldReadIngestionSettings`, and the demo's own
 * null); one of them slipping would otherwise turn straight back into a shared
 * context announcing delivery, which is precisely the bug this branch exists
 * to fix.
 *
 * Everything else is `false`, because none of them are a yes: a query in
 * flight, a query that threw, a control plane too old to carry the field, a
 * workspace with no policy row.
 *
 * ### Why this exists at all
 *
 * There is no email receiver deployed. `context.lc` has no MX route to one, so
 * mail sent to a capture address bounces with `550 5.1.1 Address does not
 * exist`. The console nevertheless rendered the address with a Copy button
 * beside the sentence "Forward any email here and it lands in 0-inbox/", and
 * the owner of this product believed it and mailed the address. Every claim
 * was in the *safe* direction — an allow-list that drops strangers, a
 * fail-closed default — which is exactly what made the whole section read as
 * live and trustworthy.
 *
 * Where there is an address, it is still shown: it is the real address, and it
 * will be correct the moment the receiver ships. What is gated is the claim
 * about what happens to anything sent to it. Where there is *no* address — a
 * shared context — nothing is shown at all; that is `describeIngestionAbsence`,
 * not this.
 */
export function receivesMail(state: IngestionState): boolean {
  return state.availability === "available" && state.settings?.receiving === true;
}

/**
 * What a context with no capture address is handed.
 *
 * There is nothing to load and nothing to save, so the state is complete the
 * moment it is built — no query is ever fired for one of these.
 */
export const NO_INGESTION_ADDRESS: IngestionState = {
  settings: null,
  loading: false,
  availability: "no-address",
};

/**
 * Which contexts get an address, decided from the workspace's `kind`.
 *
 * `kind` is the same rule `resolvePersonalContextForIngestion` enforces on
 * the backend: a personal context has a capture address, a shared one does
 * not, and sharing a personal context does not change what it is. (The
 * backend additionally requires the context to resolve to its sole owner,
 * but a personal context without one is damaged data, not a state the
 * console plans a card around — the backend answers `null` to the read and
 * refuses the save, which the card already renders honestly.)
 *
 * An `undefined` kind is the console before the workspace list has landed, not
 * an unknown kind of context. It reads as available so the card falls through to
 * its ordinary loading and empty states rather than announcing a rule about a
 * context nobody has selected yet.
 */
export function ingestionAvailabilityFor(kind: string | undefined): IngestionAvailability {
  if (kind === undefined) return "available";
  return kind === "personal" ? "available" : "no-address";
}

/**
 * Whether the console should subscribe to `getIngestionSettings` at all.
 *
 * Owner-only for the **read** as well as the write: `getIngestionSettings`
 * throws `INSUFFICIENT_ROLE` for anyone else, so firing it for a member would
 * trade a screen that says "this is the owner's" for a screen that failed. And
 * a context with no capture address has no policy to fetch — the only answer
 * that query could give is `null`, which the card would then have to tell apart
 * from "off".
 */
export function shouldReadIngestionSettings(options: {
  workspaceId: string | null;
  /** True only for an owner. */
  canEdit: boolean;
  availability: IngestionAvailability;
}): boolean {
  return (
    options.workspaceId !== null &&
    options.canEdit &&
    options.availability === "available"
  );
}

/**
 * Why the card has no allow-list to show, in the product's own words.
 *
 * Three absences, and wording any two of them the same would be a lie about
 * which one you are in:
 *
 *  - **`no-address`** — this kind of context never receives mail. There is no
 *    setting behind it and no owner who could turn it on.
 *  - **`owner-only`** — there may well be a policy; it is not yours to read.
 *  - **`off`** — the fail-closed floor of a context that *does* receive mail:
 *    no policy row, so nothing is accepted. `getIngestionSettings` documents
 *    `null` as exactly this, and it is a state the owner can leave today.
 *
 * `null` means there is something to show and the card should draw it.
 */
export type IngestionAbsence =
  | { reason: "no-address"; title: string; text: string }
  | { reason: "owner-only"; title: string; text: string }
  | { reason: "off"; text: string };

export function describeIngestionAbsence(state: IngestionState): IngestionAbsence | null {
  // First, because it is not a loading state and not an empty one: a shared
  // context is never waiting for an answer that could arrive.
  if (state.availability === "no-address") {
    return {
      reason: "no-address",
      title: "This workspace does not receive email",
      // The backend's own sentence, so somebody who ever does trip
      // `INGESTION_NOT_AVAILABLE` reads the same thing twice rather than two
      // explanations that have to be reconciled.
      text: "Only a brain receives email. A note reaches a workspace when someone moves it here.",
    };
  }
  if (state.loading || state.settings !== null) return null;
  if (state.save === undefined) {
    return {
      reason: "owner-only",
      title: "Only an owner sees these rules",
      text: "Where mail lands, and who may send it, belongs to whoever owns this brain.",
    };
  }
  return {
    reason: "off",
    // Said as what an owner has to *do*, not as what happens to mail in the
    // meantime. It used to end "…nothing sent to this address is accepted
    // until you set a target folder" — a fail-closed-sounding claim about a
    // pipeline that has never run once, and one of the sentences
    // `__tests__/captureHonesty.test.ts` bans by vocabulary.
    text: "Ingestion is off for this brain — you have to set a target folder and say who may send.",
  };
}

/**
 * What the control plane said, or a fixed sentence.
 *
 * Never the raw error text of an unknown failure — the same rule the file
 * editor's `toFileError` and `members.ts`'s `describeMembersFailure` follow. A
 * `ConvexError` payload is written for a person; anything else is whatever the
 * runtime produced, and putting that in front of somebody is how a stack trace
 * ends up in a screenshot.
 *
 * Duck-typed rather than `instanceof ConvexError` for the same reason
 * `members.ts` is: it keeps this module free of every import the landing page
 * would otherwise drag in, and it is the shape that matters, not the class.
 * `INGESTION_NOT_AVAILABLE` should be unreachable from the console — a context
 * with no address is never offered a Save button — but it is a refusal like any
 * other if it is ever hit, and it carries a sentence written to be read.
 */
export function refusalMessage(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The control plane refused the change. Try again.";
}

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
    // eslint-disable-next-line no-control-regex
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
 *
 * ### Every sentence here describes the *list*, never the pipeline
 *
 * These used to say "Mail is accepted from 1 address. Everything else is
 * dropped." — a statement about running software, made while no receiver
 * exists, so both halves were false. They now say who is *allowed*, which is a
 * fact about the rows an owner has saved and is true whether or not anything
 * is delivering yet. That keeps this function outside the `receivesMail` gate
 * on purpose: an owner configuring the list before the receiver ships should
 * still be told what they have configured, and the receiver landing must not
 * require these strings to be revisited.
 *
 * ### And none of them describes the list as a boundary
 *
 * The `ok` line used to end "Nobody else." — two words that read as a promise
 * the list cannot keep. The receiver does not verify who sent a message (see
 * the header of this file), so the list keeps out anyone who does not know an
 * address on it, and nothing more. The sentence has to leave a reader knowing
 * both halves, because the half they will assume is the wrong one.
 */
export function describeSenderPolicy(draft: IngestionDraft): {
  tone: "ok" | "warn" | "crit";
  text: string;
} {
  if (draft.allowAnySender) {
    return {
      tone: "crit",
      text: "Anyone who learns this address is allowed to post into your brain. Nothing is checked.",
    };
  }
  const entries = senderEntries(draft);
  if (entries.length === 0) {
    return {
      tone: "warn",
      text: "Nobody is allowed to send yet. Add an address or a domain.",
    };
  }
  const domains = draft.allowedDomains.length;
  const addresses = draft.allowedSenders.length;
  const parts: string[] = [];
  if (addresses > 0) parts.push(`${addresses} address${addresses === 1 ? "" : "es"}`);
  if (domains > 0) parts.push(`${domains} domain${domains === 1 ? "" : "s"}`);
  // Still `ok`. A configured list is the right state to be in, and a permanent
  // warning on the correct configuration teaches an owner to ignore warnings.
  // What changed is the sentence, which used to end "Nobody else."
  return {
    tone: "ok",
    text:
      `Only ${parts.join(" and ")} may send. That filters mail — it does not prove who sent` +
      " it, and someone who knows one of those addresses can put it in their From: line.",
  };
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
