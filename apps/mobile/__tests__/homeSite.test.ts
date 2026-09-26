import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { parseWebsitePage } from "@context/shared";
import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
} from "@context/convex/functions/lib/premium";
import {
  EARLY_TESTER_PRICE_SHORT,
  formatBytes,
  formatPrice,
} from "../features/console/settings/panels/premium";
import { BUILT_IN_PAGES } from "../features/home/builtInPages";
import {
  BUILT_IN_SITE,
  LEGAL_PAGES,
  PRIVATE_PAGE,
  homeLink,
  homeTree,
  liveHomeTree,
  pageParam,
  routeFromParam,
} from "../features/home/homeSite";
import {
  HOME_SITE_ELEMENT_ID,
  homeSourceReducer,
  initialHomeSource,
  injectedHomeSnapshot,
  isStale,
  type HomeSnapshot,
} from "../features/home/homeSnapshot";

/**
 * The homepage is a workspace of notes, and these are the rules that used to
 * guard the landing page's copy constants, pointed at its pages instead: the
 * vocabulary decisions, the claims we do not make, and the figures the
 * checkout charges. They hold the pages, which ship in the app.
 */

const SHELL = ["HomeShell.tsx", "HomePage.tsx"]
  .map((file) => readFileSync(join(__dirname, "../features/home", file), "utf8"))
  .join("\n");

/** Every sentence a visitor can read that ships in this repository. */
const PROSE: readonly string[] = [
  ...Object.values(BUILT_IN_PAGES),
  PRIVATE_PAGE.markdown,
  ...[...SHELL.matchAll(/(?:\blabel|\bplaceholder|\btext)[=:] ?"([^"]{6,})"/g)].map((match) => match[1]!),
  ...[...SHELL.matchAll(/>\s*([A-Z][^<>{}]{11,}?)\s*</gs)].map((match) => match[1]!.replace(/\s+/g, " ")),
].flatMap((text) => text.split(/\n+/)).filter((line) => line.trim() !== "");

const page = (stem: string) => {
  const found = BUILT_IN_SITE.find((candidate) => candidate.routePath === (stem === "index" ? "/" : `/${stem}`));
  if (found === undefined) throw new Error(`no built-in ${stem}`);
  return found.markdown;
};

describe("the built-in pages are website pages", () => {
  test("there are pages, and every one parses with nothing wrong", () => {
    expect(Object.keys(BUILT_IN_PAGES).length).toBeGreaterThanOrEqual(5);
    for (const [stem, source] of Object.entries(BUILT_IN_PAGES)) {
      expect({ stem, problems: parseWebsitePage(source).problems }).toEqual({ stem, problems: [] });
    }
  });

  test("the menu order is the order they are listed in", () => {
    const navs = Object.values(BUILT_IN_PAGES).map((source) => parseWebsitePage(source).nav);
    expect(navs).toEqual(navs.map((_, index) => index));
    expect(BUILT_IN_SITE[0]?.routePath).toBe("/");
  });

  test("the shell's own shell strings were found, so the rules below read them", () => {
    expect(PROSE).toContain("Search @context");
  });
});

describe("the copy obeys the vocabulary decisions", () => {
  test("no em dashes", () => {
    expect(PROSE.filter((line) => /—/.test(line))).toEqual([]);
  });

  test("the retired noun appears nowhere", () => {
    expect(PROSE.filter((line) => /\bbrains?\b/i.test(line))).toEqual([]);
  });

  test("'context' is never used for a single unit", () => {
    const asAUnit = /\b(a|an|another|each|every|this|that|these|those|\d+)\s+contexts?\b|\bcontexts\b/i;
    expect(PROSE.filter((line) => asAUnit.test(line))).toEqual([]);
  });
});

describe("the copy claims only what the product keeps", () => {
  test("no confidentiality the product does not hold", () => {
    // `docs/decisions/encryption.md`: the gateway decrypts at request time, so
    // none of these is true of the product, only of one passphrase note.
    const OVERCLAIMS: Array<[label: string, pattern: RegExp]> = [
      ["end-to-end", /end[- ]to[- ]end/i],
      ["zero-knowledge", /zero[- ]knowledge/i],
      ["we cannot read it", /\bwe\b[^.]{0,40}\b(never|cannot|can ?not|can'?t|could ?n[o']t|do ?n[o']t|do not|wo ?n[o']t|will not)\b[^.]{0,40}\b(read|see|access|decrypt|look at)\b/i],
      ["only you can read it", /\bonly you\b[^.]{0,40}\b(can|could)\b[^.]{0,40}\b(read|see|open|decrypt)\b/i],
      ["nobody else can read it", /\bno[- ]?(one|body)\b[^.]{0,40}\b(can|could)\b[^.]{0,40}\b(read|see|open|decrypt)\b/i],
      ["encrypted by default", /\bencrypted\b[^.]*\bby default\b/i],
      ["we hold nothing", /\bwe (hold|store|keep) (nothing|none)\b/i],
      ["we hold no note content", /\bwe\b[^.]{0,60}\b(hold|store|keep|retain)\b[^.]{0,60}\b(never|no|not)\b[^.]{0,40}\b(note|notes|content)\b/i],
      ["we never hold note content", /\bwe\b[^.]{0,40}\b(never|do ?n[o']t|do not|will not|wo ?n[o']t)\b[^.]{0,40}\b(hold|store|keep|retain|have)\b[^.]{0,60}\b(note|notes|content)\b/i],
      ["not in our database", /\bnot in our database\b/i],
    ];
    const offenders: string[] = [];
    for (const [label, pattern] of OVERCLAIMS) {
      for (const line of PROSE) if (pattern.test(line)) offenders.push(`${label}: ${line}`);
    }
    expect(offenders).toEqual([]);
  });

  test("where the front page promises where notes live, it names Fast Search's copy", () => {
    // CLAUDE.md non-negotiable #2: the per-context search database is ours, and
    // Fast Search puts note text in it. The storage promise carries that.
    const promise = page("index").split("\n").filter((line) => /bucket dedicated to your workspace/i.test(line));
    expect(promise).toHaveLength(1);
    expect(promise[0]).toMatch(/fast search/i);
  });
});

describe("pricing states what the checkout charges", () => {
  const pricing = page("pricing");
  const [free, managed] = pricing.split(/^## Managed/m) as [string, string];

  test("the price and the ceiling are the control plane's", () => {
    const price = formatPrice({ priceCents: PREMIUM_PRICE_CENTS, currency: PREMIUM_CURRENCY, interval: PREMIUM_INTERVAL });
    expect(price).toBe("$5 a month");
    expect(pricing).toContain(`${price} per workspace`);
    expect(managed).toContain(formatBytes(MANAGED_STORAGE_CEILING_BYTES));
    // No other figure beside the real one.
    expect(pricing.match(/\$\s?\d+/g)).toEqual(["$5", "$5"]);
  });

  test("the early-tester framing is the product's sentence", () => {
    expect(managed).toContain(EARLY_TESTER_PRICE_SHORT);
  });

  test("email capture is on the free side, because it is free", () => {
    expect(free).toMatch(/email address/i);
    expect(managed).not.toMatch(/email/i);
  });
});

describe("the tree", () => {
  test("lists the site in menu order, then the private note, then Legal", () => {
    const { tree } = homeTree(BUILT_IN_SITE);
    const root = tree.listings[""]!.entries;
    expect(root.map((entry) => entry.name)).toEqual([
      ...BUILT_IN_SITE.map((site, index) => `${String(index + 1).padStart(2, "0")}-${site.title}.md`),
      `${String(BUILT_IN_SITE.length + 1).padStart(2, "0")}-Roadmap.md`,
      "Legal",
    ]);
    expect(tree.listings.Legal!.entries.map((entry) => entry.name)).toEqual(["Privacy.md", "Terms.md"]);
    expect(tree.defaultSelection).toBe("01-Welcome.md");
  });

  test("marks only the private note", () => {
    const { tree } = homeTree(BUILT_IN_SITE);
    const root = tree.listings[""]!.entries;
    expect(root.filter((entry) => entry.exception).map((entry) => entry.name)).toEqual([
      `${String(BUILT_IN_SITE.length + 1).padStart(2, "0")}-Roadmap.md`,
    ]);
    expect(root.find((entry) => entry.exception)?.visibility).toBe("private");
    // Not "generated": that marker is for `privacy.md`, and would sit on every row.
    expect(root.some((entry) => entry.readOnly)).toBe(false);
  });

  test("a title with a slash stays one file", () => {
    const { tree, paths } = homeTree([{ routePath: "/x", title: "Q&A / FAQ", markdown: "" }]);
    expect(tree.listings[""]!.entries[0]!.name).toBe("01-Q&A - FAQ.md");
    expect(paths.get("/x")).toBe("01-Q&A - FAQ.md");
  });

  test("every route resolves to one path and back", () => {
    const { pages, paths } = homeTree(BUILT_IN_SITE);
    for (const listed of [...BUILT_IN_SITE, PRIVATE_PAGE, ...LEGAL_PAGES]) {
      expect(pages.get(paths.get(listed.routePath)!)?.routePath).toBe(listed.routePath);
    }
  });

});

describe("links inside a page", () => {
  test("the app's own screens leave the shell", () => {
    expect(homeLink("/login")).toEqual({ kind: "app", href: "/login" });
    expect(homeLink("/privacy")).toEqual({ kind: "app", href: "/privacy" });
    expect(homeLink("/s/abc")).toEqual({ kind: "app", href: "/s/abc" });
  });

  test("everything else is a page, decoded, without its fragment", () => {
    expect(homeLink("/pricing#free")).toEqual({ kind: "page", routePath: "/pricing" });
    expect(homeLink("/Public%20Worship/")).toEqual({ kind: "page", routePath: "/Public Worship" });
    expect(homeLink("/")).toEqual({ kind: "page", routePath: "/" });
    // A lookalike of an app route is a page, not the app route.
    expect(homeLink("/login-help")).toEqual({ kind: "page", routePath: "/login-help" });
  });

  test("nothing off this origin, and no malformed escape", () => {
    expect(homeLink("//evil.example")).toBeNull();
    expect(homeLink("/%E0%A4%A")).toBeNull();
  });

  test("the page is ?page= in the address, and the home page has none", () => {
    expect(pageParam("/")).toBeUndefined();
    expect(pageParam("/pricing")).toBe("pricing");
    expect(routeFromParam(undefined)).toBe("/");
    expect(routeFromParam("pricing")).toBe("/pricing");
    expect(routeFromParam(["/pricing/", "x"])).toBe("/pricing");
    expect(routeFromParam("/")).toBe("/");
  });
});

describe("the live site is website/, as its folders", () => {
  const site = [
    { routePath: "/", title: "Welcome", markdown: "# Welcome" },
    { routePath: "/how-it-works", title: "How it works", markdown: "# How" },
    { routePath: "/Legal/privacy", title: "Privacy", markdown: "# Privacy" },
    { routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
    { routePath: "/Legal/terms", title: "Terms", markdown: "# Terms" },
  ];

  test("each page sits in its folder, in menu order, a folder where its first page was", () => {
    const { tree, paths } = liveHomeTree(site);
    expect(tree.listings[""]!.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["01-Welcome.md", "file"],
      ["02-How it works.md", "file"],
      ["03-Legal", "folder"],
      ["04-Pricing.md", "file"],
    ]);
    expect(tree.listings["03-Legal"]!.entries.map((entry) => entry.path)).toEqual([
      "03-Legal/01-Privacy.md",
      "03-Legal/02-Terms.md",
    ]);
    expect(paths.get("/Legal/terms")).toBe("03-Legal/02-Terms.md");
    expect(tree.defaultSelection).toBe("01-Welcome.md");
    expect(tree.defaultExpanded).toEqual(["03-Legal"]);
  });

  test("nothing is added that the folder does not hold", () => {
    const { pages } = liveHomeTree(site);
    expect([...pages.values()].map((page) => page.routePath).sort()).toEqual(
      site.map((page) => page.routePath).sort(),
    );
    expect([...pages.values()]).not.toContain(PRIVATE_PAGE);
  });

  test("a page's file decides its folder, whatever its address", () => {
    const { tree, paths } = liveHomeTree([
      { path: "index.md", routePath: "/", title: "Write Notes", markdown: "# Write Notes" },
      { path: "Guides/start/index.md", routePath: "/Guides/start", title: "Start", markdown: "# Start" },
      { path: "untitled-2026-09-26.md", routePath: "/untitled-2026-09-26", title: "untitled-2026-09-26", markdown: "" },
    ]);
    expect(tree.listings[""]!.entries.map((entry) => entry.path)).toEqual([
      "01-Write Notes.md",
      "02-Guides",
      "03-untitled-2026-09-26.md",
    ]);
    expect(tree.listings["02-Guides/01-start"]!.entries.map((entry) => entry.path)).toEqual([
      "02-Guides/01-start/01-Start.md",
    ]);
    expect(paths.get("/Guides/start")).toBe("02-Guides/01-start/01-Start.md");
  });
});

describe("a visit decides once between the site and the copy", () => {
  const snapshot: HomeSnapshot = {
    siteName: "Context",
    revision: "1:1",
    pages: [{ routePath: "/", title: "Welcome", markdown: "# Welcome" }],
  };
  const element = (text: string | null) => ({
    getElementById: (id: string) => (id === HOME_SITE_ELEMENT_ID && text !== null ? ({ textContent: text } as HTMLElement) : null),
  });

  test("the element the app reads is the one the router writes", () => {
    const router = readFileSync(join(__dirname, "../../../infra/router/src/homeSite.ts"), "utf8");
    expect(router).toContain(`export const HOME_SITE_ELEMENT_ID = "${HOME_SITE_ELEMENT_ID}";`);
  });

  test("the site in the HTML is the first paint", () => {
    const injected = injectedHomeSnapshot(element(JSON.stringify(snapshot)));
    expect(initialHomeSource(injected, true)).toEqual({ kind: "live", snapshot });
  });

  test("each page keeps the file it is, and only a Markdown file", () => {
    const withPaths = {
      ...snapshot,
      pages: [
        { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "" },
        { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome" },
      ],
    };
    expect(injectedHomeSnapshot(element(JSON.stringify(withPaths)))).toEqual(withPaths);
    const notMarkdown = { ...snapshot, pages: [{ ...snapshot.pages[0]!, path: "index.html" }] };
    expect(injectedHomeSnapshot(element(JSON.stringify(notMarkdown)))).toBeNull();
  });

  test("a missing or broken block waits for the site rather than drawing the copy", () => {
    for (const text of [null, "{", JSON.stringify({ ...snapshot, pages: [] })]) {
      expect(initialHomeSource(injectedHomeSnapshot(element(text)), true)).toEqual({ kind: "waiting" });
    }
  });

  test("the copy is never replaced by the site: that swap was the flicker", () => {
    const copy = homeSourceReducer({ kind: "waiting" }, { type: "gaveUp" });
    expect(copy).toEqual({ kind: "builtIn" });
    expect(homeSourceReducer(copy, { type: "answered", snapshot })).toBe(copy);
    expect(homeSourceReducer({ kind: "waiting" }, { type: "answered", snapshot: null })).toEqual({ kind: "builtIn" });
  });

  test("the site is replaced only by a newer site, and only when its revision moved", () => {
    const live = initialHomeSource(snapshot, true);
    expect(isStale(live, "1:1")).toBe(false);
    expect(isStale(live, undefined)).toBe(false);
    expect(isStale(live, null)).toBe(false);
    expect(isStale(live, "2:2")).toBe(true);
    expect(homeSourceReducer(live, { type: "answered", snapshot: null })).toBe(live);
    expect(homeSourceReducer(live, { type: "gaveUp" })).toBe(live);
  });
});
