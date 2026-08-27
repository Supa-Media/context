/**
 * THE TEXT OF AN INVITATION EMAIL.
 *
 * `functions/lib/invitationEmail.ts` is pure — no `ctx`, no database, no
 * network — for the same reason `lib/invitees.ts` is: the things that can go
 * wrong here are things you want to be able to assert on directly.
 *
 * Three of them are security properties rather than copy preferences:
 *
 *  1. **Every interpolated value is attacker-controlled.** A workspace display
 *     name and a user's name are strings somebody typed. They reach an HTML
 *     body, so they are escaped; they reach a Subject header, so control
 *     characters are stripped before they can become a second header.
 *  2. **The link is built from a validated https origin**, never guessed —
 *     `consentUrlFor` refuses to invent one and so does this.
 *  3. **The sign-in code's life is bounded twice**: to its own TTL, and to
 *     strictly inside the invitation it travels with.
 */

import { describe, expect, test } from "vitest";
import {
  SIGNIN_CODE_TTL_MS,
  describeInviter,
  escapeHtml,
  formatExpiryDate,
  invitationUrlFor,
  renderInvitationEmail,
  sanitizeHeaderText,
  signInCodeExpiry,
} from "../functions/lib/invitationEmail";

const ORIGIN = { APP_ORIGIN: "https://app.context.invalid" };
const TOKEN = "a".repeat(64);
const CODE = "b".repeat(64);

/** The facts an invitation email is allowed to carry, and nothing else. */
function facts(overrides: Partial<Parameters<typeof renderInvitationEmail>[0]> = {}) {
  return {
    inviterName: "Ada Lovelace",
    inviterHandle: "ada",
    workspaceName: "Atlas Team",
    url: `https://app.context.invalid/invite/${TOKEN}`,
    expiresAt: Date.UTC(2026, 8, 3, 11, 30, 0),
    ...overrides,
  };
}

describe("naming the inviter", () => {
  test("a name and a handle read as one person", () => {
    expect(describeInviter("Ada Lovelace", "ada")).toBe("Ada Lovelace (@ada)");
  });

  test("either half alone still names somebody", () => {
    expect(describeInviter("Ada Lovelace", null)).toBe("Ada Lovelace");
    expect(describeInviter(null, "ada")).toBe("@ada");
  });

  /**
   * Neither is a real state: an account can exist with no display name and no
   * personal context. It must not render as `undefined (@undefined)` or as an
   * empty gap where a name should be — and it must not fall back to the
   * inviter's email address, which is a fact about them we were not asked to
   * disclose.
   */
  test("neither is still not a blank, and never an address", () => {
    expect(describeInviter(null, null)).toBe("Someone");
    expect(describeInviter("   ", null)).toBe("Someone");
    expect(describeInviter("", "")).toBe("Someone");
  });
});

describe("a display name cannot become a header", () => {
  test("newlines and control characters are stripped, not escaped", () => {
    const injected = "Ada\r\nBcc: victim@example.invalid";
    expect(sanitizeHeaderText(injected)).toBe("Ada Bcc: victim@example.invalid");
    expect(sanitizeHeaderText(injected)).not.toMatch(/[\r\n]/);
  });

  test("a subject built from a hostile name carries no line break", () => {
    const rendered = renderInvitationEmail(
      facts({
        inviterName: "Ada\nSubject: something else",
        workspaceName: "Atlas\r\nTeam",
      }),
    );
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  test("length is bounded, so a megabyte of name is not a megabyte of header", () => {
    expect(sanitizeHeaderText("x".repeat(5_000)).length).toBeLessThanOrEqual(200);
  });
});

describe("a display name cannot become markup", () => {
  test("the five dangerous characters are escaped", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });

  test("a script tag in a workspace name arrives as text", () => {
    const rendered = renderInvitationEmail(
      facts({ workspaceName: "<script>alert(1)</script>" }),
    );
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });
});

describe("the link", () => {
  test("is the invitation path on the configured origin", () => {
    expect(invitationUrlFor(TOKEN, null, ORIGIN)).toBe(
      `https://app.context.invalid/invite/${TOKEN}`,
    );
  });

  test("carries the sign-in code as a query parameter when there is one", () => {
    expect(invitationUrlFor(TOKEN, CODE, ORIGIN)).toBe(
      `https://app.context.invalid/invite/${TOKEN}?code=${CODE}`,
    );
  });

  /**
   * The same refusal `consentUrlFor` makes, for the same reason: a guessed
   * origin is a link we mailed to a stranger pointing somewhere we do not own.
   */
  test("refuses to guess an origin, and refuses a plaintext one", () => {
    expect(() => invitationUrlFor(TOKEN, null, {})).toThrow(/APP_ORIGIN/);
    expect(() => invitationUrlFor(TOKEN, null, { APP_ORIGIN: "" })).toThrow(
      /APP_ORIGIN/,
    );
    expect(() =>
      invitationUrlFor(TOKEN, null, { APP_ORIGIN: "http://app.context.invalid" }),
    ).toThrow(/https/);
  });

  test("a hostile token cannot escape the path segment", () => {
    const url = invitationUrlFor("../../admin?x=1", null, ORIGIN);
    expect(new URL(url).pathname).toBe("/invite/..%2F..%2Fadmin%3Fx%3D1");
    expect(new URL(url).search).toBe("");
  });
});

describe("the sign-in code's expiry", () => {
  test("matches the invitation's week, and still lands strictly inside it", () => {
    // The link is meant to work for as long as the offer it travelled with —
    // one that expires first is a link that mostly expires. What bounds it is
    // single use, not the clock: the row is deleted on first claim and when the
    // invitation is answered at all. See `SIGNIN_CODE_TTL_MS`.
    expect(SIGNIN_CODE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);

    const now = 1_800_000_000_000;
    const invitationExpiry = now + 7 * 24 * 60 * 60 * 1000;
    const expiry = signInCodeExpiry(now, invitationExpiry);

    // Equal TTLs, so the `- 1` is now the thing keeping the code inside the
    // offer rather than exactly coterminous with it. A code outliving its
    // invitation would be a bare credential with nothing left to accept.
    expect(expiry).toBe(invitationExpiry - 1);
    expect(expiry! - now).toBeLessThanOrEqual(SIGNIN_CODE_TTL_MS);
    expect(expiry!).toBeLessThan(invitationExpiry);
  });

  test("a superseded invitation drags the code down to its inherited expiry", () => {
    // The TTL and the invitation are equal for a fresh offer, so this is the
    // case where the second bound still does work: a superseded row keeps the
    // expiry of the one it replaced, which can be much closer than a week.
    const now = 1_800_000_000_000;
    const inherited = now + 2 * 60 * 60 * 1000;
    expect(signInCodeExpiry(now, inherited)).toBe(inherited - 1);
  });

  /**
   * A link that outlives the invitation it was mailed with would be a
   * credential with no offer attached to it.
   */
  test("never outlives the invitation, even when the invitation is short", () => {
    const now = 1_800_000_000_000;
    const invitationExpiry = now + 60_000;
    expect(signInCodeExpiry(now, invitationExpiry)).toBe(invitationExpiry - 1);
  });

  test("there is no code at all for an invitation that is already dead", () => {
    const now = 1_800_000_000_000;
    expect(signInCodeExpiry(now, now)).toBeNull();
    expect(signInCodeExpiry(now, now - 1)).toBeNull();
  });
});

describe("what the email says", () => {
  const rendered = renderInvitationEmail(facts());

  test("names the inviter and the context, and nothing else about either", () => {
    expect(rendered.subject).toContain("Ada Lovelace (@ada)");
    expect(rendered.subject).toContain("Atlas Team");
    expect(rendered.text).toContain("Ada Lovelace (@ada)");
    expect(rendered.text).toContain("Atlas Team");
    expect(rendered.html).toContain("Atlas Team");
  });

  test("carries the link in both alternatives", () => {
    expect(rendered.text).toContain(facts().url);
    expect(rendered.html).toContain(facts().url);
  });

  test("states the expiry as a UTC date rather than a locale's guess", () => {
    expect(formatExpiryDate(Date.UTC(2026, 8, 3, 11, 30, 0))).toBe("2026-09-03");
    expect(rendered.text).toContain("2026-09-03");
    expect(rendered.html).toContain("2026-09-03");
  });

  /**
   * The body is a function of exactly five facts. Anything else it mentioned —
   * a folder, a note count, another member — would be a fact about a private
   * context sent to an address nobody has proved they hold.
   */
  test("mentions nothing about the contents of the context", () => {
    for (const body of [rendered.subject, rendered.text, rendered.html]) {
      for (const forbidden of [
        "0-inbox",
        "1-projects",
        "2-areas",
        "3-resources",
        "4-archive",
        "privacy.md",
        "note",
        "member",
        "folder",
      ]) {
        expect(body.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
