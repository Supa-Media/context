// Shared fixtures for the auth suite, split out of `auth.test.ts` so each
// behavioural slice can stay under the file-size ceiling. Named
// `fixtures.ts` rather than `*.test.ts` so vitest does not treat it as a
// suite of its own.
import {
  describeArcShape,
  describeSender,
  domainOf,
  parseArcAuthenticationResults,
  parseAuthenticationResults,
  verifySender,
} from "../auth";
import { DEFAULT_MIME_LIMITS, parseEmail } from "../mime";
import { htmlToText } from "../html";

export {
  describeArcShape,
  describeSender,
  domainOf,
  parseArcAuthenticationResults,
  parseAuthenticationResults,
  verifySender,
  DEFAULT_MIME_LIMITS,
  parseEmail,
  htmlToText,
};

export const AUTHSERV = "mx.example-mta.test";

export function verify(headers: string[], from: string, authServiceId = AUTHSERV) {
  return verifySender({ authenticationResults: headers, fromAddress: from, authServiceId });
}

export const PASSING = (domain: string, mailbox = `alice@${domain}`) =>
  `${AUTHSERV}; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${mailbox}; dmarc=pass header.from=${domain}`;

export const MX = "mx.cloudflare.net";

export const LIMITS = DEFAULT_MIME_LIMITS;

/**
 * Drive the real `parseEmail`, then the real `verifySender`, from raw bytes.
 *
 * Message-level rather than hand-built inputs, because the two properties that
 * matter most — *where* a header sits, and whether a sender folded into one —
 * exist only in a message. A test that constructed `arcAuthenticationResults`
 * itself would be asserting about its own fixture, not about the defence.
 */
export function deliver(raw: string) {
  const parsed = parseEmail(new TextEncoder().encode(raw), LIMITS, htmlToText);
  return {
    parsed,
    verdict: verifySender({
      authenticationResults: parsed.authenticationResults,
      authenticationResultsFolded: parsed.authenticationResultsFolded,
      authenticationResultsFirstLine: parsed.authenticationResultsFirstLine,
      arcAuthenticationResults: parsed.arcAuthenticationResults,
      fromAddress: parsed.fromAddress,
      authServiceId: MX,
    }),
  };
}

/** Our MTA's own verdict on a forward: a pass for the forwarder, not the author. */
export const FORWARDED_PRIMARY =
  `Authentication-Results: ${MX}; spf=none; dkim=pass header.d=gmail.com;` +
  ` dmarc=none header.from=supa.media; arc=pass`;

/** The relayed set the forwarder sealed. Below our block; never trusted here. */
export const RELAYED_ARC =
  `ARC-Seal: i=1; a=rsa-sha256; d=google.com; s=arc-20240605; cv=none; b=Q0M=\n` +
  `ARC-Message-Signature: i=1; a=rsa-sha256; d=google.com; s=arc-20240605; b=RE Q=\n` +
  `ARC-Authentication-Results: i=1; mx.google.com; spf=pass smtp.mailfrom=seyi@supa.media;` +
  ` dkim=pass header.d=supa.media; dmarc=pass header.from=supa.media`;

/** What our MTA is inferred to add when it validates and re-seals the chain. */
export const OUR_ARC =
  `ARC-Seal: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; cv=pass; b=QUE=\n` +
  `ARC-Message-Signature: i=2; a=rsa-sha256; d=cloudflare.net; s=2024; b=QkI=\n` +
  `ARC-Authentication-Results: i=2; ${MX}; spf=pass smtp.mailfrom=seyi@supa.media;` +
  ` dkim=pass header.d=supa.media; dmarc=pass header.from=supa.media`;

export const FROM_AND_BODY = `From: seyi@supa.media\nSubject: fwd\n\nhi\n`;
