/**
 * Establishing *who actually sent this*, before any allow-list is consulted.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * A `From:` header is a claim, not a fact. Anyone with an SMTP client can send
 * mail that says `From: seyi@supa.media`. So an ingestion allow-list that
 * matches on the `From:` header alone is not a control — it is a control-shaped
 * hole: the one identity an attacker most wants to present is exactly the one
 * the allow-list invites them to type.
 *
 * That makes the order non-negotiable:
 *
 *   1. establish an identity the sender **proved** (this file),
 *   2. *then* ask the recipient's own policy whether that identity is allowed.
 *
 * A message that fails authentication is refused **even when its claimed
 * `From:` is on the allow-list**. There is no branch in which a passing
 * allow-list check rescues a failing authentication check.
 *
 * ============================================================================
 * WHAT WE CAN ACTUALLY PROVE, AND WHAT WE CANNOT
 * ============================================================================
 *
 * Cloudflare Email Routing performs SPF, DKIM and DMARC evaluation at the MX
 * and records the verdict in an `Authentication-Results` header (RFC 8601). The
 * Email Worker runtime exposes no structured verdict object, so that header is
 * the only channel — and the header is also something the *sender* may write.
 * Three rules make it usable anyway:
 *
 * 1. **Only the topmost `Authentication-Results` is read.** A receiving MTA
 *    prepends its trace headers, so anything the sender wrote sits below.
 * 2. **Its authserv-id must equal a value the operator configured.** A sender
 *    who forges a header with someone else's authserv-id gets a refusal, not a
 *    pass. This is `AUTH_SERVICE_ID` in wrangler.jsonc; there is no default,
 *    and with it unset the Worker refuses everything.
 * 3. **A second header bearing our authserv-id is fatal.** Two verdicts from
 *    the same authority mean one of them is forged, and we do not get to pick.
 *
 * 4. **A folded topmost header is fatal.** RFC 5322 unfolding appends a first
 *    sender line beginning with SP or HTAB to the last header the MTA wrote.
 *    That is still *one* header, so rule 3 cannot see it. See rule 1a in
 *    `verifySender`.
 *
 * The residual assumption — that our MTA's header really is topmost — is an
 * assumption about another system's behaviour, and this repository's rule is
 * that a guard nobody has checked is not a guard. It must be checked against a
 * real delivery before this Worker is enabled; see the deployment note in
 * wrangler.jsonc. `parseAuthenticationResults` and `verifySender` are pure so
 * that check can be a fixture, not a ritual.
 *
 * ============================================================================
 * FORWARDING, AND THE CHAIN
 * ============================================================================
 *
 * Alignment, below, refuses forwarded mail by construction: the `From:` stays
 * the original sender's while the delivering hop's DKIM signature belongs to
 * the forwarder. Since "forward anything here and it lands in your context" is
 * the product, that is not a corner case — it is the case.
 *
 * ARC (RFC 8617) is the mechanism designed to carry the first receiver's
 * verdict across that hop, and `verifyViaArc` reads it — under five conditions
 * documented in full there, of which the load-bearing one is **position**: an
 * ARC set is ours only if it sits above the topmost `Authentication-Results`,
 * inside the block our MTA prepended, where a sender cannot write. Read that
 * comment before touching any of it; the naive version of this feature hands
 * every sender a `dmarc=pass` for anyone they like.
 *
 * **And what a pass actually proves is a DOMAIN, not a mailbox.** SPF
 * authorises a sending host for a domain; DKIM proves a domain signed the
 * message. Neither proves the local part. So an allow-list entry naming
 * `alice@example.com` is, in practice, trust extended to everyone who can send
 * as `example.com`. That is inherent to email and is worth saying out loud
 * rather than implying otherwise with a per-address list.
 *
 * ============================================================================
 * ALIGNMENT
 * ============================================================================
 *
 * A pass on its own is meaningless: `evil.test` can publish a perfect SPF
 * record and DKIM-sign everything it sends. What matters is whether the passing
 * identity is the *same domain as the `From:` header* — alignment. An attacker
 * who controls `evil.test` can set any `From:` they like and cannot make it
 * align.
 *
 * Alignment here is **exact domain equality**, deliberately:
 *
 *   - not a suffix test (`evil-example.com` must never match `example.com`),
 *   - not organisational-domain relaxation (`mail.example.com` is not
 *     `example.com`; list it separately if you want it).
 *
 * The same rule the policy matcher uses for allowed domains, for the same
 * reason: the "helpful" widening is where the bypass lives.
 */

/** One `method=result` clause with its properties, e.g. `dkim=pass header.d=…`. */
export interface AuthMethodResult {
  method: string;
  result: string;
  properties: Record<string, string>;
}

export interface AuthenticationResults {
  authservId: string;
  results: AuthMethodResult[];
}

/** Bounds. An `Authentication-Results` header is a few hundred bytes in life. */
const MAX_HEADER_CHARS = 4_000;
const MAX_CLAUSES = 24;
const MAX_PROPERTIES = 16;

/**
 * Strip RFC 5322 comments, honouring nesting and backslash escapes.
 *
 * `spf=pass (example.com: domain of alice designates …)` is legal and common,
 * and a comment may contain a `;` — so comments have to go before the clause
 * split, or one comment silently truncates the verdict.
 */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\" && depth > 0) {
      index += 1;
      continue;
    }
    if (char === "(") {
      // A depth cap rather than unbounded recursion; deep nesting is not mail.
      if (depth < 32) depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

/** Split on `;` while respecting quoted-strings. Linear, no backtracking. */
function splitClauses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') quoted = false;
      else current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ";") {
      out.push(current);
      current = "";
      if (out.length >= MAX_CLAUSES) return out;
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/**
 * Parse an `Authentication-Results` header value (RFC 8601).
 *
 * Returns `null` when the value is not one — including when it carries no
 * authserv-id, which is the shape a naive forgery tends to have.
 */
export function parseAuthenticationResults(value: string): AuthenticationResults | null {
  const clauses = boundedClauses(value);
  if (!clauses) return null;
  return parseClauses(clauses);
}

/** Comment-stripped, bounded, `;`-split. `null` when there is nothing to read. */
function boundedClauses(value: string): string[] | null {
  if (typeof value !== "string" || !value) return null;
  const bounded = value.length > MAX_HEADER_CHARS ? value.slice(0, MAX_HEADER_CHARS) : value;
  const clauses = splitClauses(stripComments(bounded));
  return clauses.length ? clauses : null;
}

/**
 * The clause-level core, shared with `parseArcAuthenticationResults`.
 *
 * Shared rather than copied: an `ARC-Authentication-Results` value *is* an
 * `Authentication-Results` value with one extra clause in front (RFC 8617
 * §4.1.1). Two parsers meant to agree about what `dmarc=pass` looks like, which
 * then drift, is a way to end up believing in one header what the other would
 * have refused.
 */
function parseClauses(clauses: string[]): AuthenticationResults | null {
  // The first clause is `authserv-id [ version ]`.
  const head = clauses[0]!.trim().split(/\s+/).filter(Boolean);
  const authservId = (head[0] || "").toLowerCase();
  if (!authservId || !/^[a-z0-9._-]{1,255}$/.test(authservId)) return null;

  const results: AuthMethodResult[] = [];
  for (const clause of clauses.slice(1)) {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const first = tokens[0]!;
    const eq = first.indexOf("=");
    if (eq <= 0) {
      // `none` is the legal way to say "no authentication was attempted". It is
      // a clause with no `=`, and it is not a pass.
      continue;
    }
    // A method may carry a version: `dkim/1=pass`.
    const method = first.slice(0, eq).split("/")[0]!.toLowerCase();
    const result = first.slice(eq + 1).toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(method)) continue;
    if (!/^[a-z]{1,16}$/.test(result)) continue;

    const properties: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      if (Object.keys(properties).length >= MAX_PROPERTIES) break;
      const at = token.indexOf("=");
      if (at <= 0) continue;
      const key = token.slice(0, at).toLowerCase();
      const propertyValue = token.slice(at + 1);
      if (!/^[a-z]{1,16}\.[a-z-]{1,32}$/.test(key)) continue;
      if (!(key in properties)) properties[key] = propertyValue;
    }
    results.push({ method, result, properties });
    if (results.length >= MAX_CLAUSES) break;
  }

  return { authservId, results };
}

/* ----------------------------------- ARC ---------------------------------- */

/** An `Authentication-Results` payload plus the ARC instance that carried it. */
export interface ArcAuthenticationResults extends AuthenticationResults {
  /** The `i=` tag. 1 is the first hop; the receiving MTA's set is the highest. */
  instance: number;
}

/**
 * Parse an `ARC-Authentication-Results` header value (RFC 8617 §4.1.1).
 *
 * The value is an ordinary `Authentication-Results` value with the ARC instance
 * tag prepended as its own clause:
 *
 *   ARC-Authentication-Results: i=1; mx.example.net; dkim=pass header.d=…
 *
 * Which is exactly why `parseAuthenticationResults` cannot be pointed at one:
 * `i=1` lands in the slot RFC 8601 reserves for the authserv-id, contains `=`,
 * which that charset excludes, and the whole header is rejected as malformed.
 * A test in ./auth.test.ts used to pin that as the reason Cloudflare's mail was
 * refused.
 *
 * `null` for anything that is not this shape — no instance tag, an instance
 * outside RFC 8617's 1–50, or a payload `parseClauses` will not read. Callers
 * must treat `null` as a refusal and not as "skip this one": see `verifyViaArc`.
 */
export function parseArcAuthenticationResults(value: string): ArcAuthenticationResults | null {
  const clauses = boundedClauses(value);
  if (!clauses || clauses.length < 2) return null;
  const tag = /^i=(\d{1,3})$/.exec(clauses[0]!.trim());
  if (!tag) return null;
  const instance = Number(tag[1]);
  // RFC 8617 §5.1.2: a chain is at most 50 sets, and instance numbers start at
  // 1. Outside that it is not a chain we are willing to reason about.
  if (!Number.isInteger(instance) || instance < 1 || instance > 50) return null;
  const parsed = parseClauses(clauses.slice(1));
  if (!parsed) return null;
  return { instance, authservId: parsed.authservId, results: parsed.results };
}

/**
 * One `ARC-Authentication-Results` header as `verifySender` needs it.
 *
 * Structurally identical to `ArcHeader` in ./mime.ts, and deliberately declared
 * again here rather than imported: this module has no imports at all, so it can
 * be reasoned about — and fuzzed, and sabotage-tested — as a pure function of
 * strings and booleans. TypeScript's structural typing makes the two the same
 * type at every call site anyway.
 */
export interface ArcHeaderInput {
  value: string;
  /** Assembled from folded continuation lines, i.e. sender-extendable. */
  folded: boolean;
  /** It sits strictly above the topmost `Authentication-Results`. */
  abovePrimary: boolean;
}

/* --------------------------------- verdict -------------------------------- */

export type AuthFailure =
  | "not_configured"
  | "no_authentication_results"
  | "foreign_authserv_id"
  | "ambiguous_authentication_results"
  | "folded_authentication_results"
  | "unparseable_authentication_results"
  | "no_from_address"
  | "not_authenticated"
  | "unaligned"
  | "folded_arc_authentication_results"
  | "unparseable_arc_authentication_results"
  | "ambiguous_arc_authentication_results";

/** The base methods, and the same methods reached through a validated chain. */
export type AuthMethodName =
  | "dmarc"
  | "dkim"
  | "spf"
  | "arc-dmarc"
  | "arc-dkim"
  | "arc-spf";

export type SenderVerdict =
  | {
      ok: true;
      /** The `From:` addr-spec, now backed by an aligned passing method. */
      address: string;
      /** Its domain, lowercased. What the authentication actually proved. */
      domain: string;
      /**
       * An `arc-` prefix means the alignment was found in an ARC set rather
       * than in our MTA's own verdict — a weaker claim, and one the capture
       * note therefore states rather than hides.
       */
      method: AuthMethodName;
    }
  | { ok: false; reason: AuthFailure };

/** Lowercased domain of an addr-spec, or `""`. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return "";
  return address.slice(at + 1).toLowerCase();
}

/**
 * Exact, case-insensitive domain equality. Not a suffix test — never a suffix
 * test. `evil-example.com`, `example.com.evil.test` and `mail.example.com` are
 * all different domains from `example.com`.
 */
function sameDomain(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export interface VerifySenderInput {
  /**
   * Every `Authentication-Results` header value, **in the order they appear in
   * the message**. Order is the whole security argument; a `Headers` object
   * that merged them is not usable here.
   */
  authenticationResults: string[];
  /**
   * Parallel to `authenticationResults`: whether each arrived folded. Optional
   * so a caller that cannot know (a test, a future transport) is not forced to
   * assert something false — absent is treated as "not folded", which is the
   * pre-existing behaviour, and ./mime.ts always supplies it.
   */
  authenticationResultsFolded?: boolean[];
  /**
   * Every `ARC-Authentication-Results` header, in message order. Optional for
   * the same reason; absent means "no chain", which is a refusal, never a pass.
   */
  arcAuthenticationResults?: ArcHeaderInput[];
  /** The `From:` header's addr-spec, already extracted. */
  fromAddress: string;
  /** The operator-configured authserv-id. Empty means "not configured". */
  authServiceId: string;
}

/**
 * Alignment, factored out of `verifySender` so the ARC path runs the *same*
 * rules over the ARC set that the direct path runs over our MTA's verdict.
 *
 * Two copies of "is this pass aligned?" that drifted would mean an ARC set
 * could buy an acceptance the direct header could not, which is precisely the
 * asymmetry an attacker would go looking for.
 */
type Alignment =
  | { ok: true; method: "dmarc" | "dkim" | "spf" }
  | { ok: false; reason: "unaligned" | "not_authenticated" };

function evaluateAlignment(results: AuthMethodResult[], fromDomain: string): Alignment {
  const find = (method: string) => results.find((entry) => entry.method === method);

  // DMARC first: it is the only method that evaluates alignment itself, so a
  // `dmarc=pass` whose `header.from` is our From domain is the strongest thing
  // this header can say.
  const dmarc = find("dmarc");
  if (dmarc && dmarc.result === "pass") {
    const claimed = dmarc.properties["header.from"];
    // Some MTAs omit `header.from`. DMARC is defined against the From domain,
    // so its absence is not a mismatch — but when it *is* present and names a
    // different domain, that is a verdict about someone else's mail.
    if (!claimed || sameDomain(claimed, fromDomain)) return { ok: true, method: "dmarc" };
    return { ok: false, reason: "unaligned" };
  }

  // No DMARC verdict (or a failing one). Fall back to checking alignment by
  // hand, which is what DMARC would have done.
  const dkim = find("dkim");
  if (dkim && dkim.result === "pass" && sameDomain(dkim.properties["header.d"] || "", fromDomain)) {
    return { ok: true, method: "dkim" };
  }

  const spf = find("spf");
  if (spf && spf.result === "pass") {
    const mailfrom = spf.properties["smtp.mailfrom"] || "";
    // `smtp.mailfrom` may be a full address or a bare domain.
    const spfDomain = mailfrom.includes("@") ? domainOf(mailfrom) : mailfrom.toLowerCase();
    const helo = (spf.properties["smtp.helo"] || "").toLowerCase();
    if (sameDomain(spfDomain, fromDomain) || (!mailfrom && sameDomain(helo, fromDomain))) {
      return { ok: true, method: "spf" };
    }
  }

  // Something passed, but for a domain other than the one the message claims to
  // be from. That is the spoof case, and it is worth its own reason in the log
  // even though the sender sees the same refusal as everyone else.
  const anyPass = results.some(
    (entry) => entry.result === "pass" && ["dkim", "spf", "dmarc"].includes(entry.method),
  );
  return { ok: false, reason: anyPass ? "unaligned" : "not_authenticated" };
}

/* ------------------------------ the ARC path ------------------------------ */

type ArcOutcome =
  | { kind: "pass"; method: "dmarc" | "dkim" | "spf" }
  | { kind: "refuse"; reason: AuthFailure }
  /** No ARC evidence to weigh. The direct path's own reason stands. */
  | { kind: "none" };

/**
 * Decide whether an ARC set may stand in for our MTA's own verdict.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * "Forward anything here and it lands in your context" is the product, and
 * forwarding is exactly the case ordinary alignment refuses. A forwarded
 * message keeps `From: alice@example.com` while the delivering hop's DKIM
 * signature belongs to the forwarder, so `header.d` does not match the From
 * domain and the message is refused — for looking precisely like what it is.
 * ARC (RFC 8617) exists to carry the *original* receiver's verdict across that
 * hop, which is why Cloudflare can report `ARC pass` on a message whose DMARC
 * is `none`.
 *
 * ============================================================================
 * WHY BELIEVING IT IS DANGEROUS, AND WHAT MAKES IT SAFE
 * ============================================================================
 *
 * A sender writes every header they send. `ARC-Authentication-Results` is a
 * plain text header with no signature of its own, so "start reading ARC" done
 * naively means "let anyone type `dmarc=pass header.from=anyone.com`". Five
 * conditions, all required, and each closing a different hole:
 *
 * 1. **Our MTA said the chain validated.** `arc=pass`, read from the topmost
 *    `Authentication-Results` — the one header this Worker already establishes
 *    as ours by authserv-id. That is where RFC 8617 §5.2 says the chain
 *    validation status goes, and it is not in the ARC set itself: an ARC set
 *    cannot vouch for its own chain. Without it there is no chain, and a
 *    message with no chain that carries ARC headers is a message someone typed
 *    ARC headers into.
 *
 * 2. **It sits above the topmost `Authentication-Results`.** This is the one
 *    that actually stops the forgery, and it is the same argument the rest of
 *    this file already runs on: the receiving MTA prepends its trace block as a
 *    unit, so everything the *sender* wrote is below it. An attacker cannot put
 *    a header above ours without being our MTA. Note what this does *not* rely
 *    on: not on the instance number (the attacker picks that), not on the
 *    authserv-id (the attacker types that too), not on the seal (we cannot
 *    verify one here). Position is the only discriminator a Worker actually
 *    has.
 *
 * 3. **It bears our authserv-id.** Belt to condition 2's braces. A relayed set
 *    from an upstream ADMD names that ADMD, and if one somehow appeared inside
 *    our MTA's block it is still not our MTA speaking.
 *
 * 4. **It is the highest instance in the message.** RFC 8617 numbers sets
 *    `i=1, 2, …` in the order they were added, so the receiving MTA's is the
 *    newest and the only one whose *contents* it composed. Everything below is
 *    a relayed claim. If anything else in the message claims that instance or a
 *    higher one, the numbering contradicts itself and we do not get to pick.
 *
 * 5. **It was not folded.** Identical treatment to `Authentication-Results`,
 *    for the identical attack: a sender whose first header line begins with SP
 *    or HTAB has it appended, by correct RFC 5322 unfolding, to the last header
 *    the MTA wrote. One header, so no duplicate check can see it.
 *
 * Plus: **anything unparseable refuses.** Condition 4 is a claim about the
 * whole set of ARC headers, and a set with an unreadable member is one whose
 * maximum we cannot compute. Refusing beats guessing.
 *
 * ============================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO — READ BEFORE "FIXING" FORWARDING
 * ============================================================================
 *
 * It does not read a *lower* instance, and for the common forwarding path that
 * means it changes nothing. Work the real case through: Gmail forwards, so
 * Gmail seals `i=1` and its AAR names `mx.google.com` and records what Gmail
 * saw — `dmarc=pass header.from=example.com`, the original verdict, the thing
 * we actually want. Our MTA validates the chain and says `arc=pass`. If our MTA
 * adds a set of its own it is `i=2`, and its AAR records *its* view of the
 * message as delivered — the same misaligned DKIM the direct header already
 * showed. So the instance we are allowed to trust carries nothing new, and the
 * instance carrying the answer is one we have no basis to trust.
 *
 * Closing that gap is a different mechanism, not a loosened version of this
 * one: trusting `i=1` means trusting *the domain that sealed it*, which is
 * knowable only from `ARC-Seal: i=1; d=…` under `cv=pass`, and only against an
 * operator-configured list of forwarders they have decided to believe. RFC 8617
 * §7.2 says as much: a validated chain proves integrity, not honesty — anyone
 * can seal a chain of their own lies. That is a deliberate product decision
 * with a new configuration surface, and it is not one to make silently inside a
 * parser.
 */
function verifyViaArc(
  arcHeaders: ArcHeaderInput[],
  primary: AuthenticationResults,
  authServiceId: string,
  fromDomain: string,
): ArcOutcome {
  // Condition 1. Read from our MTA's own verdict, never from an ARC set.
  const chain = primary.results.find((entry) => entry.method === "arc");
  if (!chain || chain.result !== "pass") return { kind: "none" };
  if (!arcHeaders.length) return { kind: "none" };

  const parsed: { header: ArcHeaderInput; set: ArcAuthenticationResults }[] = [];
  for (const header of arcHeaders) {
    const set = parseArcAuthenticationResults(header.value);
    if (!set) return { kind: "refuse", reason: "unparseable_arc_authentication_results" };
    parsed.push({ header, set });
  }

  // Conditions 2 and 3, in that order of importance.
  const ours = parsed.filter(
    (entry) => entry.header.abovePrimary && entry.set.authservId === authServiceId,
  );
  if (!ours.length) return { kind: "none" };
  if (ours.length > 1) return { kind: "refuse", reason: "ambiguous_arc_authentication_results" };

  const mine = ours[0]!;

  // Condition 5, before anything is read out of the value.
  if (mine.header.folded) return { kind: "refuse", reason: "folded_arc_authentication_results" };

  // Condition 4.
  for (const entry of parsed) {
    if (entry === mine) continue;
    if (entry.set.instance >= mine.set.instance) {
      return { kind: "refuse", reason: "ambiguous_arc_authentication_results" };
    }
  }

  const alignment = evaluateAlignment(mine.set.results, fromDomain);
  return alignment.ok ? { kind: "pass", method: alignment.method } : { kind: "none" };
}

/**
 * A bounded description of the ARC shape a message arrived in.
 *
 * ## Why this exists, and why it is safe to log
 *
 * Every condition in `verifyViaArc` is a claim about headers **nobody has
 * captured from a real Cloudflare delivery**. Whether Cloudflare stamps an ARC
 * set of its own before a Worker sees the message, and if so where it puts it
 * relative to `Authentication-Results`, decides whether the ARC path can ever
 * fire — and neither fact is in any documentation. Without a way to look, the
 * operator's only signal is that mail is still refused, which is what they had
 * before.
 *
 * So: **integers and one closed enum, nothing else.** No header name, no
 * authserv-id, no address, no fragment of any value. Nothing a sender writes
 * can reach the log through this string, which is the property that makes it
 * loggable at all — and it is why this returns a formatted summary rather than
 * "the names of the headers we saw", which would have put attacker-chosen text
 * into a log aggregator.
 */
export function describeArcShape(input: VerifySenderInput): string {
  const arcHeaders = input.arcAuthenticationResults || [];
  const primary = parseAuthenticationResults(input.authenticationResults[0] || "");
  const authServiceId = input.authServiceId.trim().toLowerCase();
  const chain = primary?.results.find((entry) => entry.method === "arc");
  const sets = arcHeaders.map((header) => parseArcAuthenticationResults(header.value));

  const readable = sets.filter((set): set is ArcAuthenticationResults => set !== null);
  const above = arcHeaders.filter((header) => header.abovePrimary).length;
  const ours = arcHeaders.filter(
    (header, index) =>
      header.abovePrimary && sets[index] !== null && sets[index]!.authservId === authServiceId,
  ).length;
  const top = readable.reduce((best, set) => Math.max(best, set.instance), 0);

  // `chain` is one of the four values RFC 8617 registers, or "absent".
  const status = chain ? chain.result.slice(0, 8) : "absent";
  return `chain=${status} headers=${arcHeaders.length} readable=${readable.length} above=${above} ours=${ours} top=${top}`;
}

/**
 * Decide whether the `From:` address is one the sender proved they may use.
 *
 * Pure and total: every path returns a verdict, and a `false` verdict is the
 * only thing a caller may act on other than a full pass.
 */
export function verifySender(input: VerifySenderInput): SenderVerdict {
  const authServiceId = input.authServiceId.trim().toLowerCase();
  if (!authServiceId) return { ok: false, reason: "not_configured" };

  const from = input.fromAddress.trim();
  const fromDomain = domainOf(from);
  if (!from || !fromDomain) return { ok: false, reason: "no_from_address" };

  const headers = input.authenticationResults;
  if (!headers.length) return { ok: false, reason: "no_authentication_results" };

  // Rule 1a: the topmost verdict must not have been folded.
  //
  // The sender's headers begin immediately below the ones the MTA prepended, so
  // a message whose first header line starts with SP or HTAB has that line
  // appended — by correct RFC 5322 unfolding — to the last header the MTA
  // wrote. When that is this header, the sender has written into our verdict.
  //
  // Rule 3 below cannot see it: there is still only one header bearing our
  // authserv-id, because nothing was added — ours was extended. Nor would a
  // duplicate-clause check help, because the attack works precisely when the
  // MTA *omits* the method being forged, so there is no duplicate to notice.
  // Refusing the fold is what closes it.
  //
  // Conservative on purpose: an MTA may legitimately fold a long header of its
  // own, and this refuses those too. Ingestion is fail-closed by design, and
  // the deployment checklist already requires inspecting a real delivery before
  // enabling — whether the MTA folds its own `Authentication-Results` belongs
  // in that same look.
  if (input.authenticationResultsFolded?.[0] === true) {
    return { ok: false, reason: "folded_authentication_results" };
  }

  const parsed = parseAuthenticationResults(headers[0]!);
  if (!parsed) return { ok: false, reason: "unparseable_authentication_results" };

  // Rule 2: the topmost verdict must be from the authority we configured. A
  // sender who prepends their own with a different authserv-id fails here
  // rather than being skipped over in search of a friendlier one — searching
  // down the list is precisely how a forged header wins.
  if (parsed.authservId !== authServiceId) {
    return { ok: false, reason: "foreign_authserv_id" };
  }

  // Rule 3: a second verdict claiming our authority means one is forged.
  let ours = 0;
  for (const header of headers) {
    const other = parseAuthenticationResults(header);
    if (other && other.authservId === authServiceId) ours += 1;
  }
  if (ours > 1) return { ok: false, reason: "ambiguous_authentication_results" };

  // ── Our MTA's own verdict. Unchanged, and always asked first. ─────────────
  //
  // Order is a security property, not a preference. A non-forwarded message
  // resolves entirely here, so nothing about the ARC path below can turn one of
  // its refusals into an acceptance: reaching that path at all requires our own
  // MTA to have said `arc=pass`, which it does not say about a message with no
  // chain in it.
  const direct = evaluateAlignment(parsed.results, fromDomain);
  if (direct.ok) return { ok: true, address: from, domain: fromDomain, method: direct.method };

  // ── The chain, only now, and only under the conditions in `verifyViaArc`. ─
  //
  // Note where this sits: after `parsed` has been established as *our MTA's*
  // header — not folded, parseable, our authserv-id, unambiguous. Every
  // structural refusal above is therefore final, and ARC cannot rescue one.
  const arc = verifyViaArc(
    input.arcAuthenticationResults || [],
    parsed,
    authServiceId,
    fromDomain,
  );
  if (arc.kind === "pass") {
    return { ok: true, address: from, domain: fromDomain, method: `arc-${arc.method}` };
  }
  if (arc.kind === "refuse") return { ok: false, reason: arc.reason };

  return { ok: false, reason: direct.reason };
}
