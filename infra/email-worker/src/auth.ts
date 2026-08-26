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
 * The residual assumption — that our MTA's header really is topmost — is an
 * assumption about another system's behaviour, and this repository's rule is
 * that a guard nobody has checked is not a guard. It must be checked against a
 * real delivery before this Worker is enabled; see the deployment note in
 * wrangler.jsonc. `parseAuthenticationResults` and `verifySender` are pure so
 * that check can be a fixture, not a ritual.
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
  if (typeof value !== "string" || !value) return null;
  const bounded = value.length > MAX_HEADER_CHARS ? value.slice(0, MAX_HEADER_CHARS) : value;
  const clauses = splitClauses(stripComments(bounded));
  if (!clauses.length) return null;

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

/* --------------------------------- verdict -------------------------------- */

export type AuthFailure =
  | "not_configured"
  | "no_authentication_results"
  | "foreign_authserv_id"
  | "ambiguous_authentication_results"
  | "unparseable_authentication_results"
  | "no_from_address"
  | "not_authenticated"
  | "unaligned";

export type SenderVerdict =
  | {
      ok: true;
      /** The `From:` addr-spec, now backed by an aligned passing method. */
      address: string;
      /** Its domain, lowercased. What the authentication actually proved. */
      domain: string;
      method: "dmarc" | "dkim" | "spf";
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
  /** The `From:` header's addr-spec, already extracted. */
  fromAddress: string;
  /** The operator-configured authserv-id. Empty means "not configured". */
  authServiceId: string;
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

  const find = (method: string) => parsed.results.find((entry) => entry.method === method);

  // DMARC first: it is the only method that evaluates alignment itself, so a
  // `dmarc=pass` whose `header.from` is our From domain is the strongest thing
  // this header can say.
  const dmarc = find("dmarc");
  if (dmarc && dmarc.result === "pass") {
    const claimed = dmarc.properties["header.from"];
    // Some MTAs omit `header.from`. DMARC is defined against the From domain,
    // so its absence is not a mismatch — but when it *is* present and names a
    // different domain, that is a verdict about someone else's mail.
    if (!claimed || sameDomain(claimed, fromDomain)) {
      return { ok: true, address: from, domain: fromDomain, method: "dmarc" };
    }
    return { ok: false, reason: "unaligned" };
  }

  // No DMARC verdict (or a failing one). Fall back to checking alignment by
  // hand, which is what DMARC would have done.
  const dkim = find("dkim");
  if (dkim && dkim.result === "pass" && sameDomain(dkim.properties["header.d"] || "", fromDomain)) {
    return { ok: true, address: from, domain: fromDomain, method: "dkim" };
  }

  const spf = find("spf");
  if (spf && spf.result === "pass") {
    const mailfrom = spf.properties["smtp.mailfrom"] || "";
    // `smtp.mailfrom` may be a full address or a bare domain.
    const spfDomain = mailfrom.includes("@") ? domainOf(mailfrom) : mailfrom.toLowerCase();
    const helo = (spf.properties["smtp.helo"] || "").toLowerCase();
    if (sameDomain(spfDomain, fromDomain) || (!mailfrom && sameDomain(helo, fromDomain))) {
      return { ok: true, address: from, domain: fromDomain, method: "spf" };
    }
  }

  // Something passed, but for a domain other than the one the message claims to
  // be from. That is the spoof case, and it is worth its own reason in the log
  // even though the sender sees the same refusal as everyone else.
  const anyPass = parsed.results.some(
    (entry) => entry.result === "pass" && ["dkim", "spf", "dmarc"].includes(entry.method),
  );
  return { ok: false, reason: anyPass ? "unaligned" : "not_authenticated" };
}
