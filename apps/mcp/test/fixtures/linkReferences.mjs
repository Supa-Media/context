/**
 * Shared cases for `extractReferences` and `resolveReference`.
 *
 * Plain data, no imports from `src/`: the gateway test (`linkReferences.test.mjs`)
 * and the shared package's parity test both read this table, so the two ports of
 * the reader are held to the same answers. `catalog` is JSON-shaped
 * (`byName` as an object, `paths` as an array); each test turns it into the
 * `Map` and `Set` the functions take.
 *
 * `expected` is the list of occurrences in document order. `start` and `end` are
 * computed from the text by `at`, so a case reads as "this target, this
 * resolution" and not as arithmetic.
 */

/** The span of the `nth` (0-based) occurrence of `needle` in `text`. */
function at(text, needle, nth = 0) {
  let from = -1;
  for (let i = 0; i <= nth; i += 1) {
    from = text.indexOf(needle, from + 1);
    if (from === -1) throw new Error(`fixture: no occurrence ${nth} of ${needle}`);
  }
  return { start: from, end: from + needle.length };
}

function occ(text, needle, fields, nth = 0) {
  return { embed: false, fragment: "", ...at(text, needle, nth), ...fields, target: fields.target ?? needle };
}

const NOTES = ["1-projects/alpha/overview.md", "1-projects/alpha/plan.md", "2-areas/health.md", "2-areas/ops/overview.md", "readme.md"];
const catalog = {
  byName: {
    overview: ["1-projects/alpha/overview.md", "2-areas/ops/overview.md"],
    plan: ["1-projects/alpha/plan.md"],
    health: ["2-areas/health.md"],
    readme: ["readme.md"],
  },
  paths: NOTES,
};
const noPaths = { byName: catalog.byName };
const from = "1-projects/alpha/notes.md";

const wiki = "See [[plan]] now.";
const alias = "See [[plan|the plan]] now.";
const embed = "![[plan]]";
const title = 'A [x](./plan.md "The plan") link.';
const angle = "A [x](<./plan.md>) link.";
const spaced = "A [x](../beta/my%20note.md) link.";
const anchor = "[[plan#Goals]] and [[plan#^abc123]] and [x](./plan.md#goals)";
const long = `[[plan]] ${"x".repeat(2100)} [y](./${"d/".repeat(1100)}far.md)`;
const code = "Inline `[[plan]]` and `[x](./plan.md)` then [[health]]";
const fenced = "```\n[[plan]]\n[x](./plan.md)\n```\n[[health]]";
const unterminated = "[[health]]\n```\n[[plan]]\n[x](./plan.md)\n";
const definition = "[ref]: ./plan.md\n\n[[health]]";
const externalDefinition = "[ref]: https://example.com/x";
const externals = "[a](https://example.com/x) [b](mailto:me@example.com) [c](//cdn.example.com/x)";
const escaping = "[[../../../outside]] and [x](../../../../outside.md)";
const anchorOnly = "[x](#goals) and [[#goals]]";
const bare2 = "[[overview]]";
const bare0 = "[[nowhere]]";
const rootedAndRelative = "[[1-projects/alpha/plan]] [[./plan]] [[../../2-areas/health]] [[1-projects/gone]]";
const extension = "[img](./pic.png)";
const dotsOnly = "[x](./)";
const dotWiki = "[[.]]";
const dotDotWiki = "[[..]]";
const dotDotInline = "[x](..)";

const wikiBase = { kind: "wiki", style: "bare" };

export const referenceCases = [
  {
    name: "wiki link",
    text: wiki,
    fromPath: from,
    catalog,
    expected: [occ(wiki, "plan", { ...wikiBase, resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "wiki alias leaves the target alone",
    text: alias,
    fromPath: from,
    catalog,
    expected: [occ(alias, "plan", { ...wikiBase, resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "embed",
    text: embed,
    fromPath: from,
    catalog,
    expected: [occ(embed, "plan", { ...wikiBase, embed: true, resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "inline link with a title",
    text: title,
    fromPath: from,
    catalog,
    expected: [occ(title, "./plan.md", { kind: "inline", style: "relative", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "angle-bracketed target",
    text: angle,
    fromPath: from,
    catalog,
    expected: [occ(angle, "./plan.md", { kind: "inline", style: "relative", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "percent-encoded space is decoded for style and resolution",
    text: spaced,
    fromPath: from,
    catalog: { ...catalog, paths: [...NOTES, "1-projects/beta/my note.md"] },
    expected: [occ(spaced, "../beta/my%20note.md", { kind: "inline", style: "relative", resolution: { state: "resolved", path: "1-projects/beta/my note.md" } })],
  },
  {
    name: "heading anchor, block anchor and inline anchor",
    text: anchor,
    fromPath: from,
    catalog,
    expected: [
      occ(anchor, "plan#Goals", { ...wikiBase, fragment: "#Goals", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
      occ(anchor, "plan#^abc123", { ...wikiBase, fragment: "#^abc123", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
      occ(anchor, "./plan.md#goals", { kind: "inline", style: "relative", fragment: "#goals", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
    ],
  },
  {
    name: "a link past 2,048 characters is still found",
    text: long,
    fromPath: from,
    catalog,
    expected: [
      occ(long, "plan", { ...wikiBase, resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
      occ(long, `./${"d/".repeat(1100)}far.md`, {
        kind: "inline",
        style: "relative",
        resolution: { state: "missing" },
      }),
    ],
  },
  {
    name: "links inside inline code are ignored",
    text: code,
    fromPath: from,
    catalog,
    expected: [occ(code, "health", { ...wikiBase, resolution: { state: "resolved", path: "2-areas/health.md" } })],
  },
  {
    name: "links inside a fenced block are ignored",
    text: fenced,
    fromPath: from,
    catalog,
    expected: [occ(fenced, "health", { ...wikiBase, resolution: { state: "resolved", path: "2-areas/health.md" } })],
  },
  {
    name: "an unterminated fence swallows the rest of the document",
    text: unterminated,
    fromPath: from,
    catalog,
    expected: [occ(unterminated, "health", { ...wikiBase, resolution: { state: "resolved", path: "2-areas/health.md" } })],
  },
  {
    name: "a reference definition is reported and unsupported",
    text: definition,
    fromPath: from,
    catalog,
    expected: [
      occ(definition, "./plan.md", { kind: "definition", style: "relative", resolution: { state: "unsupported" } }),
      occ(definition, "health", { ...wikiBase, resolution: { state: "resolved", path: "2-areas/health.md" } }),
    ],
  },
  {
    name: "a definition with a URL target is external, not unsupported",
    text: externalDefinition,
    fromPath: from,
    catalog,
    expected: [occ(externalDefinition, "https://example.com/x", { kind: "definition", style: null, resolution: { state: "external" } })],
  },
  {
    name: "URLs, mailto and protocol-relative targets are external",
    text: externals,
    fromPath: from,
    catalog,
    expected: [
      occ(externals, "https://example.com/x", { kind: "inline", style: null, resolution: { state: "external" } }),
      occ(externals, "mailto:me@example.com", { kind: "inline", style: null, resolution: { state: "external" } }),
      occ(externals, "//cdn.example.com/x", { kind: "inline", style: null, resolution: { state: "external" } }),
    ],
  },
  {
    name: "a path that escapes the root is invalid",
    text: escaping,
    fromPath: from,
    catalog,
    expected: [
      occ(escaping, "../../../outside", { ...wikiBase, style: "relative", resolution: { state: "invalid" } }),
      occ(escaping, "../../../../outside.md", { kind: "inline", style: "relative", resolution: { state: "invalid" } }),
    ],
  },
  {
    name: "a path that normalizes to nothing is invalid",
    text: dotsOnly,
    fromPath: "top.md",
    catalog,
    expected: [occ(dotsOnly, "./", { kind: "inline", style: "relative", resolution: { state: "invalid" } })],
  },
  {
    name: "a bare dot is invalid, not a missing name",
    text: dotWiki,
    fromPath: from,
    catalog,
    expected: [occ(dotWiki, ".", { ...wikiBase, resolution: { state: "invalid" } })],
  },
  {
    name: "a bare double dot is invalid, not a missing name",
    text: dotDotWiki,
    fromPath: from,
    catalog,
    expected: [occ(dotDotWiki, "..", { ...wikiBase, resolution: { state: "invalid" } })],
  },
  {
    name: "an inline link to a bare double dot is invalid",
    text: dotDotInline,
    fromPath: from,
    catalog,
    expected: [occ(dotDotInline, "..", { kind: "inline", style: "bare", resolution: { state: "invalid" } })],
  },
  {
    name: "anchor-only targets are invalid",
    text: anchorOnly,
    fromPath: from,
    catalog,
    expected: [
      occ(anchorOnly, "#goals", { kind: "inline", style: null, fragment: "#goals", resolution: { state: "invalid" } }),
      occ(anchorOnly, "#goals", { ...wikiBase, style: null, fragment: "#goals", resolution: { state: "invalid" } }, 1),
    ],
  },
  {
    name: "a bare name with two candidates is ambiguous",
    text: bare2,
    fromPath: from,
    catalog,
    expected: [occ(bare2, "overview", { ...wikiBase, resolution: { state: "ambiguous" } })],
  },
  {
    name: "a bare name with no candidates is missing when paths are known",
    text: bare0,
    fromPath: from,
    catalog,
    expected: [occ(bare0, "nowhere", { ...wikiBase, resolution: { state: "missing" } })],
  },
  {
    name: "a bare name with no candidates is unknown without paths",
    text: bare0,
    fromPath: from,
    catalog: noPaths,
    expected: [occ(bare0, "nowhere", { ...wikiBase, resolution: { state: "unknown" } })],
  },
  {
    name: "a bare name with one candidate resolves without paths",
    text: wiki,
    fromPath: from,
    catalog: noPaths,
    expected: [occ(wiki, "plan", { ...wikiBase, resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } })],
  },
  {
    name: "rooted and relative targets, with paths",
    text: rootedAndRelative,
    fromPath: from,
    catalog,
    expected: [
      occ(rootedAndRelative, "1-projects/alpha/plan", { ...wikiBase, style: "rooted", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
      occ(rootedAndRelative, "./plan", { ...wikiBase, style: "relative", resolution: { state: "resolved", path: "1-projects/alpha/plan.md" } }),
      occ(rootedAndRelative, "../../2-areas/health", { ...wikiBase, style: "relative", resolution: { state: "resolved", path: "2-areas/health.md" } }),
      occ(rootedAndRelative, "1-projects/gone", { ...wikiBase, style: "rooted", resolution: { state: "missing" } }),
    ],
  },
  {
    name: "rooted and relative targets, without paths",
    text: rootedAndRelative,
    fromPath: from,
    catalog: noPaths,
    expected: [
      occ(rootedAndRelative, "1-projects/alpha/plan", { ...wikiBase, style: "rooted", resolution: { state: "unknown" } }),
      occ(rootedAndRelative, "./plan", { ...wikiBase, style: "relative", resolution: { state: "unknown" } }),
      occ(rootedAndRelative, "../../2-areas/health", { ...wikiBase, style: "relative", resolution: { state: "unknown" } }),
      occ(rootedAndRelative, "1-projects/gone", { ...wikiBase, style: "rooted", resolution: { state: "unknown" } }),
    ],
  },
  {
    name: "an attachment keeps its extension",
    text: extension,
    fromPath: from,
    catalog: { ...catalog, paths: [...NOTES, "1-projects/alpha/pic.png"] },
    expected: [occ(extension, "./pic.png", { kind: "inline", style: "relative", resolution: { state: "resolved", path: "1-projects/alpha/pic.png" } })],
  },
];
