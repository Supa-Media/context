/**
 * The breadcrumb's visibility chip.
 *
 * Pure, so it runs in plain node. It is tested on its own because it is a
 * **claim about who can read this note**, printed where somebody decides
 * whether to type something sensitive into it.
 *
 * The three cases are easy to collapse into two by somebody tidying up — and
 * the moment they are, a note that merely follows a `team` folder and a note
 * deliberately shared as an exception read identically. Those are different
 * situations: the first becomes private the moment its folder does, the second
 * stays shared until someone changes the note. The tree deliberately marks only
 * the exception, so the breadcrumb is the only place the distinction is spelled
 * out in words.
 */

import { describe as group, expect, test } from "@jest/globals";
import { describe } from "../features/console/files/Breadcrumb";

group("what the chip says", () => {
  test("a note carrying its own rule says so", () => {
    expect(
      describe({ visibility: "team", inherited: "private", exception: true, readOnly: false }),
    ).toBe("team — set on this note");
    expect(
      describe({ visibility: "private", inherited: "team", exception: true, readOnly: false }),
    ).toBe("private — set on this note");
  });

  test("a note following its folder says that instead", () => {
    expect(
      describe({ visibility: "team", inherited: "team", exception: false, readOnly: false }),
    ).toBe("team — follows its folder");
    expect(
      describe({ visibility: "private", inherited: "private", exception: false, readOnly: false }),
    ).toBe("private — follows its folder");
  });

  test("inheriting and excepting are never the same sentence", () => {
    // The collapse this file exists to prevent.
    const inherited = describe({
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    });
    const excepted = describe({
      visibility: "team",
      inherited: "private",
      exception: true,
      readOnly: false,
    });
    expect(inherited).not.toBe(excepted);
  });

  test("an inheriting note is described by its folder's value, not its own", () => {
    // The two agree in practice, but reading `visibility` here would make the
    // chip silently wrong the moment they ever diverged.
    expect(
      describe({ visibility: "team", inherited: "private", exception: false, readOnly: false }),
    ).toBe("private — follows its folder");
  });

  test("privacy.md is the map, not a thing on it", () => {
    expect(
      describe({ visibility: "private", inherited: "private", exception: false, readOnly: true }),
    ).toBe("the access map");
    // Read-only wins over everything: privacy.md has no visibility of its own.
    expect(
      describe({ visibility: "team", inherited: "team", exception: true, readOnly: true }),
    ).toBe("the access map");
  });
});
