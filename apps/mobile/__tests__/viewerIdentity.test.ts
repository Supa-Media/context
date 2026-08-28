import { describe, expect, test } from "@jest/globals";
import { ownPersonalContext, viewerIdentity } from "../features/console/identity";

/**
 * The signed-in identity is the viewer's, never the viewed context's.
 *
 * The reported bug: clicking into a shared context changed "the username at
 * the top, at the bottom, everywhere" — the avatar took the *selected* slug's
 * initial, and the account block took the first `kind === "personal"` context
 * in the list, which is somebody else's the moment one is shared with you.
 */

const own = { slug: "seyi", kind: "personal", role: "owner" };
const guestPersonal = { slug: "lk", kind: "personal", role: "member" };
const guestShared = { slug: "public-worship", kind: "shared", role: "editor" };

describe("ownPersonalContext", () => {
  test("kind alone is not ownership", () => {
    // `lk` is first and personal — the exact shape the old
    // `find(kind === "personal")` resolved to somebody else.
    expect(ownPersonalContext([guestPersonal, own])).toBe(own);
  });

  test("a shared workspace you own is not a personal context", () => {
    expect(ownPersonalContext([{ slug: "team", kind: "shared", role: "owner" }])).toBeNull();
  });

  test("an invited-only account owns nothing", () => {
    expect(ownPersonalContext([guestPersonal, guestShared])).toBeNull();
  });
});

describe("viewerIdentity", () => {
  test("an owner is their own handle, wherever the list puts it", () => {
    const identity = viewerIdentity({ contexts: [guestPersonal, guestShared, own] });
    expect(identity.name).toBe("@seyi");
    expect(identity.initial).toBe("S");
    // The derived capture address is the viewer's own, never a guest
    // context's — `lk@context.lc` here would be the reported bug.
    expect(identity.detail).toBe("seyi@context.lc");
  });

  test("the real issued address wins over the derived one", () => {
    const identity = viewerIdentity({
      contexts: [own],
      ownAddress: "seyi@inbox.context.lc",
    });
    expect(identity.detail).toBe("seyi@inbox.context.lc");
  });

  test("an invited-only viewer is their email, never the viewed slug", () => {
    const identity = viewerIdentity({
      contexts: [guestPersonal, guestShared],
      email: "guest@example.com",
    });
    expect(identity.name).toBe("guest@example.com");
    expect(identity.initial).toBe("G");
    // No capture address: only a personal context has one, and they have none.
    expect(identity.detail).toBeUndefined();
  });

  test("nothing known yet is a neutral 'Signed in', not a borrowed name", () => {
    for (const email of [undefined, "", "   "]) {
      const identity = viewerIdentity({ contexts: [guestPersonal], email });
      expect(identity.name).toBe("Signed in");
      expect(identity.initial).toBe("?");
      expect(identity.detail).toBeUndefined();
    }
  });

  test("the identity does not depend on which context is being viewed", () => {
    // Pure in, pure out: nothing about a selection is even an input. The
    // assertion is that the same list answers the same identity regardless of
    // order, which is the property the account block needs.
    const a = viewerIdentity({ contexts: [own, guestPersonal] });
    const b = viewerIdentity({ contexts: [guestPersonal, own] });
    expect(a).toEqual(b);
  });
});
