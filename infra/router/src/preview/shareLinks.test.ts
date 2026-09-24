// Split out of `preview.test.ts`: share links (the one card that may say
// something) and readable team links. `crawlersAndCards.test.ts` covers
// crawler detection and the marketing/OG-card checks;
// `notesAndShortLinks.test.ts` covers note previews and short links.
// `fixtures.ts` holds the shared imports and helpers.
import { describe, expect, it } from "vitest";
import {
  ogCard,
  GENERIC_PREVIEW,
  OG_CARD_PATH,
  escapeHtml,
  isCrawler,
  previewFor,
  previewForShare,
  previewFromProfile,
  renderPreviewHtml,
  shareTokenFrom,
  consoleNoteFrom,
  previewForNote,
  shortLinkFrom,
  previewForShortLink,
  shortLinkCardFrom,
  shortLinkCardPath,
  route,
  shareSegmentCases,
  shortLinkSlugCases,
  previewHtml,
  meta,
} from "./fixtures";

describe("share links: the one card that may say something", () => {
  // The exception to the rule the block above tests, and the tests here are
  // what keep it an exception rather than a hole. Read `previewForShare` in
  // preview.ts before changing any of them.

  it("only a well-formed token is a share link", () => {
    const token = "a".repeat(64);
    expect(shareTokenFrom(`/s/${token}`)).toBe(token);
    expect(shareTokenFrom(`/s/${token}/`)).toBe(token);
  });

  it.each([
    ["/s/", "no token at all"],
    ["/s/short", "too short"],
    ["/s/" + "a".repeat(63), "one character short"],
    ["/s/" + "a".repeat(65), "one character long"],
    ["/s/" + "A".repeat(64), "uppercase — not what randomOpaqueToken emits"],
    ["/s/" + "g".repeat(64), "not hex"],
    ["/s/" + "a".repeat(64) + "/extra", "a second segment"],
    ["/s/../../etc/passwd", "traversal"],
    ["/share/" + "a".repeat(64), "the frozen prefix, which stays frozen"],
    ["/@alice", "a name-bearing path"],
  ])("%s is not a share link (%s)", (pathname) => {
    expect(shareTokenFrom(pathname)).toBeNull();
  });

  /**
   * The shape check is what stops `/s/<garbage>` from reaching the control
   * plane at all — so the obvious probe (hammer the prefix and time the
   * answers) never gets a lookup to time.
   */
  it("a malformed token never becomes a lookup", () => {
    const decision = route(new URL("https://context.lc/s/nope"), "Slackbot");
    expect(decision.kind).toBe("preview");
  });

  it("a well-formed token routes to the lookup branch", () => {
    const token = "b".repeat(64);
    const decision = route(new URL(`https://context.lc/s/${token}`), "Slackbot");
    expect(decision).toEqual({ kind: "share-preview", token });
  });

  it("a human gets the app, not a card", () => {
    const token = "b".repeat(64);
    const decision = route(
      new URL(`https://context.lc/s/${token}`),
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    );
    expect(decision.kind).toBe("proxy");
  });

  /**
   * The router's half of one rule that lives in two deployments.
   *
   * `shareTokenFromSegment` in `apps/mobile/features/share/share.ts` reads the
   * same URL shape and cannot be imported here, so both run over the corpus in
   * `shareSegment.fixtures.json` and neither is trusted to match a comment.
   * The one that matters most is `token` being read off the **end**: a slug is
   * whatever the owner's note is called, so it can contain hex, and a search
   * rather than an anchor would let a title decide which token was looked up.
   */
  it.each(shareSegmentCases.cases.map((c) => [c.why, c.segment, c.token] as const))(
    "%s",
    (_why, segment, token) => {
      expect(shareTokenFrom(`/s/${segment}`)).toBe(token);
    },
  );

  /**
   * AND THE CORPUS ITSELF IS PINNED, BECAUSE IT IS THE ONLY THING HOLDING THE
   * TWO COPIES TOGETHER.
   *
   * Both suites run it — sabotage either parser from an anchor to a search and
   * six checks fail on each side — but nothing was checking its *size*.
   * Deleting all twelve negative cases left both suites green at their previous
   * counts, and the concrete hole that leaves is measurable: relaxing
   * `^([A-Za-z0-9][A-Za-z0-9-]*)` to `^([A-Za-z0-9-]+)` in one copy passed
   * every check, because the corpus had `-<64hex>` and not `--<64hex>`.
   *
   * An enumeration nobody checks the size of is a list that shrinks, which is
   * the discipline `UNAUTHENTICATED_HTTP_ROUTES` and `CREDENTIAL_BARRIERS`
   * already follow one repository over. The floor is asserted rather than the
   * exact count, so adding a case is free and removing one is not.
   */
  /**
   * A CI GAP THIS SUITE CANNOT CLOSE, RECORDED WHERE THE CORPUS IS EDITED.
   *
   * The corpus exists to hold `shareTokenFrom` here and
   * `shareTokenFromSegment` in `apps/mobile` together, and both suites do run
   * it — but only one of them runs in CI when the corpus changes. The file
   * lives under `infra/router/src/`, so editing it triggers `router.yml`
   * (`paths: infra/router/**`) while the reusable workflow's change detection
   * skips `ci / Test Mobile App`, which is gated on `apps/mobile/**`. Measured
   * on the commit that added six cases: `Test Edge Router` ran, `Test Mobile
   * App` was skipped. So the edit the corpus is *designed* to receive is
   * checked against one of the two implementations it exists to compare.
   *
   * Running the app's parser from this suite was tried and reverted: esbuild
   * resolves the nearest tsconfig for an imported file, which for anything
   * under `apps/mobile/` is one that extends `expo/tsconfig.base`, and the
   * router's CI job installs only its own workspace deps. It passes locally
   * with the whole workspace installed and fails in CI, which is the worst
   * shape a guard can have.
   *
   * The two real fixes are both larger than a test: make the two copies one
   * module that both import, or get the mobile job to trigger on this path.
   * Until then, **run `npx jest __tests__/shareViewer.test.ts` in `apps/mobile`
   * by hand when you touch this file** — CI will not do it for you.
   */
  it("the shared corpus keeps its negative cases", () => {
    const cases = shareSegmentCases.cases;
    const refused = cases.filter((c) => c.token === null);
    expect(cases.length, "cases were removed from the corpus").toBeGreaterThanOrEqual(25);
    expect(refused.length, "the refusals are the half that guards the charset").toBeGreaterThanOrEqual(18);

    // Each hazard by name, because a count alone is satisfied by twenty copies
    // of one shape. These are the classes a divergence would hide in.
    for (const [hazard, matches] of [
      // Scoped to the tail. `/[A-F]/` alone is satisfied by `Chapter-transition`
      // — a slug case, not the hazard — so replacing the one genuine
      // uppercase-hex case with a lowercase near-duplicate kept this green.
      // The failure the corpus's own comment names: a case that passes for two
      // different reasons reads as coverage and is not.
      ["uppercase hex", (c: string) => /(?:^|-)[0-9a-fA-F]{64}$/.test(c) && /[A-F]/.test(c)],
      // A hex run of the wrong length, wherever in the segment it sits — the
      // corpus spells these with a slug in front.
      ["a wrong length", (c: string) => /(?:^|-)[0-9a-f]{63}$|(?:^|-)[0-9a-f]{65}$/.test(c)],
      ["a leading separator", (c: string) => c.startsWith("-")],
      ["a percent escape", (c: string) => c.includes("%")],
      ["a non-ASCII separator", (c: string) => /[^\x00-\x7F]/.test(c)],
      ["a path separator", (c: string) => c.includes("/") || c.includes(".")],
    ] as const) {
      expect(
        refused.some((c) => matches(c.segment)),
        `the corpus lost its case for ${hazard}`,
      ).toBe(true);
    }
  });

  it("a title reaches the card", () => {
    const meta = previewForShare("Chapter transition");
    expect(meta.title).toBe("Chapter transition — Context");
  });

  /**
   * THE test for this feature. Every way a lookup can come back empty —
   * unknown token, revoked, expired, title switched off, upstream down,
   * timeout, malformed JSON — arrives here as a falsy title, and every one of
   * them must render the frozen card byte for byte. That is what makes
   * revocation invisible: a crawler cannot tell a share that was taken back
   * from one that never existed.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an empty title (%p) is the frozen card, byte for byte",
    (title) => {
      expect(renderPreviewHtml(previewForShare(title))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  /**
   * …and openness cannot rescue an absence into a card. A crawler that could
   * tell "revoked, and it used to be an open link" from "never existed" has
   * learned something, so the frozen card has to win over the second argument
   * as completely as it wins over the first.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an empty title (%p) is still the frozen card when the link is open",
    (title) => {
      expect(renderPreviewHtml(previewForShare(title, undefined, true))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  /**
   * An unlisted link's reader needs no account, and a card that tells them to
   * sign in is the product being wrong on the first surface a stranger sees —
   * the kind of wrong that stops the link being opened at all, which is the
   * whole reason a share card carries a title.
   */
  it("an open link's card does not ask for a sign-in", () => {
    const open = previewForShare("Chapter transition", undefined, true);
    expect(open.description).not.toMatch(/sign in/i);
    expect(open.description).toMatch(/no account needed/i);
  });

  it("…and every other share's card still does", () => {
    for (const meta of [
      previewForShare("Chapter transition"),
      previewForShare("Chapter transition", undefined, false),
    ]) {
      expect(meta.description).toMatch(/sign in to read it/i);
    }
  });

  /**
   * The default is the narrow one, so an upstream that has not been taught
   * about this field — older, newer, or wrong — sends the reader to sign in
   * rather than promising them access they may not have.
   */
  it("the sign-in wording is what you get without being told otherwise", () => {
    expect(previewForShare("Chapter transition").description).toBe(
      previewForShare("Chapter transition", undefined, false).description,
    );
  });

  it("a share card still refuses everything the frozen one refuses", () => {
    const html = renderPreviewHtml(previewForShare("Chapter transition"));

    // The canonical URL is the site root, never the requested share path.
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(meta(html, "property", "og:url")).toEqual(["https://context.lc/"]);
    // Still out of search results.
    expect(meta(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    // Still the product's own card image.
    expect(meta(html, "property", "og:image")).toEqual([
      "https://context.lc/og/card.png",
    ]);
    // And nothing beyond the title: no owner, no path, no context name.
    expect(html).not.toContain("1-projects");
    expect(html).not.toContain("@");
  });

  it("a hostile title cannot break out of the markup", () => {
    const html = renderPreviewHtml(
      previewForShare('</title><script>alert(1)</script><meta x="'),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  /**
   * Bounded at the edge as well as in the control plane. An edge that trusts
   * its upstream to have been careful is an edge with no bound at all.
   */
  it("a very long title is truncated here too", () => {
    const meta = previewForShare("x".repeat(500));
    expect(meta.title.length).toBeLessThanOrEqual(60 + " — Context".length);
  });
});

describe("a readable team link", () => {
  /**
   * The rule that replaced "every console URL is frozen", and the two halves
   * are what make it safe:
   *
   *  - A console URL **with no linked note** is frozen, exactly as before.
   *  - A note link unfurls **only when the owner has team-linked that note** —
   *    the control plane answers `null` for everything else, and `null` renders
   *    GENERIC_PREVIEW byte for byte.
   *
   * So probing `?note=<guess>` reveals the set of notes the owner already chose
   * to publish a card for, and nothing about the rest of the context. That was
   * their call, made with the unguessable-token alternative in front of them,
   * because a link nobody can read is a link nobody clicks.
   */
  it("is recognised only in the shape the console actually produces", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/a.md")),
    ).toEqual({ slug: "seyi", path: "1-projects/a.md" });
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/%40seyi?note=a.md")),
    ).toEqual({ slug: "seyi", path: "a.md" });
  });

  it.each([
    ["https://context.lc/console/@seyi", "no note"],
    ["https://context.lc/console/@seyi/settings?note=a.md", "not the browse route"],
    ["https://context.lc/console?note=a.md", "no context"],
    ["https://context.lc/console/@seyi?note=/etc/passwd", "rooted"],
    ["https://context.lc/console/@seyi?note=../../privacy.md", "traversal"],
    ["https://context.lc/console/@seyi?note=1-projects/../../x.md", "traversal inside"],
    ["https://context.lc/console/@seyi?note=.history/a.md", "history"],
    ["https://context.lc/console/@seyi?note=privacy.md", "the access map"],
    ["https://context.lc/console/@Seyi?note=a.md", "not a handle shape"],
    ["https://context.lc/@seyi?note=a.md", "not a console URL"],
  ])("%s is not one (%s)", (href) => {
    expect(consoleNoteFrom(new URL(href))).toBeNull();
  });

  /**
   * **A folder the owner named routes like anything else they named.**
   *
   * This asserted the opposite a commit ago, and the reversal is the point: the
   * preview turns on *guessability*, and file-versus-folder was only ever a
   * proxy for it. `/@name/1-projects` is five guesses per handle and is still
   * refused below — by name, where that refusal belongs — but
   * `1-projects/pilot` is a name its owner typed, exactly like
   * `1-projects/pilot/overview.md`.
   */
  it("routes a folder the owner named", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/pilot")),
    ).toEqual({ slug: "seyi", path: "1-projects/pilot" });
  });

  /** ...and the five it did not. */
  it.each(["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"])(
    "does not route %s, which every workspace has",
    (path) => {
      expect(
        consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${path}`)),
      ).toBeNull();
    },
  );

  /**
   * The shape of that refusal: **exact**, not `startsWith`. Writing it as a
   * prefix — the obvious way to say "and everything under it" — would refuse
   * every note in the workspace, since all of them live under a PARA folder, and
   * the frozen card would be back for everything without a test noticing.
   */
  it.each([
    ["1-projects-archive", "a name that begins with a scaffolded one"],
    ["1-projects/pilot", "a folder inside one"],
    ["1-projects/plan.md", "a note inside one"],
  ])("%s is still routed (%s)", (path) => {
    expect(
      consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${path}`)),
    ).not.toBeNull();
  });

  /**
   * Two more that are not routed. `.images/a.md` is held by the dot-segment
   * rule, and dropping that rule fails this.
   *
   * `scopes.yml` is the interesting one. It was **unpinnable** while a
   * note-only rule stood here — it does not end in `.md`, so that rule refused
   * it first and deleting the explicit check left this green. The comment then
   * said the check was kept because "it becomes load-bearing again the moment
   * the note-only line is relaxed". That moment is now, and this test has teeth
   * it did not have: delete `path === "scopes.yml"` and it fails.
   */
  it.each([
    ["https://context.lc/console/@seyi?note=scopes.yml", "the legacy scope map"],
    ["https://context.lc/console/@seyi?note=.images/a.md", "the image store"],
  ])("%s is not one (%s)", (href) => {
    expect(consoleNoteFrom(new URL(href))).toBeNull();
  });

  /**
   * The names the product writes itself, which are guessable however unguessable
   * an arbitrary filename is. Restated here from
   * `apps/convex/functions/lib/scaffold.ts` because this package is a separate
   * deployment; the control-plane copy is driven off `scaffoldFiles` directly,
   * so a new scaffolded file fails there and this list is the one to update —
   * and `teamShare.test.ts` asserts these thirteen equal what it derives, so
   * the update is not optional.
   *
   * `privacy.md` is in the list and would pass here regardless, because the
   * explicit plumbing line above already refuses it.
   */
  it.each([
    "index.md",
    "privacy.md",
    "todo.md",
    "0-inbox/README.md",
    "1-projects/README.md",
    "2-areas/README.md",
    "3-resources/README.md",
    "4-archive/README.md",
    "0-inbox",
    "1-projects",
    "2-areas",
    "3-resources",
    "4-archive",
  ])("%s is a name anybody can guess, so it is not routed", (note) => {
    expect(
      consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${note}`)),
    ).toBeNull();
  });

  it("while a name the owner chose is routed", () => {
    expect(
      consoleNoteFrom(
        new URL("https://context.lc/console/@seyi?note=1-projects/acme-migration.md"),
      ),
    ).toEqual({ slug: "seyi", path: "1-projects/acme-migration.md" });
  });

  it("is routed when the extension is upper case, which is still a note", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/UPPER.MD")),
    ).toEqual({ slug: "seyi", path: "1-projects/UPPER.MD" });
  });

  it("routes a crawler to the lookup, and a person to the app", () => {
    const url = new URL("https://context.lc/console/@seyi?note=1-projects/a.md");
    expect(route(url, "Slackbot 1.0")).toEqual({
      kind: "note-preview",
      slug: "seyi",
      path: "1-projects/a.md",
    });
    expect(
      route(url, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36")
        .kind,
    ).toBe("proxy");
  });

  it("a linked note gets its title, and its card", () => {
    const meta = previewForNote("Chapter transition", "a".repeat(64));
    expect(meta.title).toBe("Chapter transition — Context");
    expect(meta.imageUrl).toContain(`/og/s/${"a".repeat(64)}.png`);
  });

  /**
   * THE test. Unlinked, revoked, expired, title switched off, control plane
   * unreachable — every one arrives as a falsy title, and every one must render
   * the frozen card byte for byte. That is what keeps the probe to "has the
   * owner published this one".
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an unlinked note (%p) is the frozen card, byte for byte",
    (title) => {
      expect(renderPreviewHtml(previewForNote(title, "a".repeat(64)))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  it("a console URL with no note is still frozen", () => {
    for (const pathname of ["/console/@seyi", "/console/@seyi/settings", "/console"]) {
      expect(previewHtml(pathname)).toBe(previewHtml("/@alice"));
    }
  });

  it("still refuses everything the frozen card refuses", () => {
    const html = renderPreviewHtml(previewForNote("Chapter transition", "b".repeat(64)));
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(meta(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    // The title, and nothing else about the context.
    expect(html).not.toContain("seyi");
    expect(html).not.toContain("1-projects");
  });

  it("a hostile title cannot break out of the markup", () => {
    const html = renderPreviewHtml(
      previewForNote('</title><script>alert(1)</script>', "c".repeat(64)),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

