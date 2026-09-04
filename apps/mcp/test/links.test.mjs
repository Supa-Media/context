/**
 * LINKS FOLLOW WHAT THEY POINT AT — `src/links.js`, and the four move tools.
 *
 * The ask, in the owner's words: "when the name is updated references to it are
 * also updated automatically … by default the reference always changes when
 * things are moved or renamed." So this suite is not "does the regex match". It
 * is the four things that make an automatic rewrite of somebody's own files
 * safe enough to be a default:
 *
 * 1. **It finds the links that are there** — wikilinks in every shape an
 *    Obsidian vault contains, and CommonMark inline links.
 * 2. **It leaves alone everything that is not a link into this bucket** — code,
 *    external URLs, anchors, attachments, and a bare name that more than one
 *    note answers to.
 * 3. **Relative links are recomputed, not substituted.** This is the one that
 *    a plausible implementation gets wrong: when a folder moves, a link
 *    *inside* it pointing *outside* it needs a different number of `../`, and
 *    a rewriter that only swapped the moved paths would break every one of them
 *    while reporting success.
 * 4. **A rewrite never widens what a connection can reach.** The walk is
 *    filtered by `canSee`, the same rule `move_folder` already applies to the
 *    objects it moves.
 *
 * The pure half runs against text. The wired half stands up its own worker,
 * control plane and bucket — the shared fixture in `test.mjs` is a privacy
 * fixture and adding link content to it would couple two unrelated suites.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `expressLink` always emitting the target's full path                    17
 *   `codeRanges` returning `[]`                                              6
 *   `rewriteLinks` ignoring the referrer's own move                          3
 *   the `canSee` filter dropped from `rewriteReferences`                     2
 *   `normalizeSegments` clamping `..` at the root rather than refusing        2
 *   a bare link rewritten without the uniqueness check                        1
 *
 * The first row is the finding, and it is a finding about *this file* rather
 * than about the source. The first attempt at it replaced the branch head with
 * `if (false)` and left the `else if` chain below intact, so relative and
 * rooted targets were still handled correctly and only **two** checks failed —
 * a number that reads like thin coverage and was actually a sabotage that
 * barely sabotaged anything. Forcing the assignment after the chain instead
 * failed seventeen. A sabotage record is only worth the care taken that the
 * sabotage landed.
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  codeRanges,
  dirOf,
  expressLink,
  indexByName,
  normalizeSegments,
  parseLinks,
  relativePath,
  resolveLink,
  rewriteLinks,
  styleOf,
} from "../src/links.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

/* --------------------------------- pure ---------------------------------- */

const NOTE = "1-projects/persistence/overview.md";

/** The rewrite of one body, with nothing moving but the referrer. */
function rewrite(text, { from = NOTE, to = NOTE, renames = new Map(), names = [] } = {}) {
  return rewriteLinks(text, {
    fromPath: from,
    toPath: to,
    renames,
    byName: indexByName(names),
  });
}

export async function runLinkChecks(check) {
  /* -- (1) what is a link ------------------------------------------------- */

  {
    const text =
      "a [[one]] b [[two|alias]] c ![[three]] d [[four#heading]] e [lbl](five.md) " +
      "f [lbl](<six seven.md>) g [lbl](eight.md \"title\")";
    const targets = parseLinks(text).map((link) => link.target);
    check(
      "every wikilink and inline shape is found, and only the target is taken",
      JSON.stringify(targets) ===
        JSON.stringify(["one", "two", "three", "four#heading", "five.md", "six seven.md", "eight.md"])
    );

    const alias = parseLinks("[[two|alias]]")[0];
    check(
      "a wikilink's span covers the target and stops at the pipe",
      "[[two|alias]]".slice(alias.start, alias.end) === "two"
    );
    const embed = parseLinks("![[three]]")[0];
    check(
      "an embed's span skips its own marker",
      "![[three]]".slice(embed.start, embed.end) === "three"
    );
    const bracketed = parseLinks("[lbl](<six seven.md>)")[0];
    check(
      "a bracketed inline target's span excludes the angle brackets",
      "[lbl](<six seven.md>)".slice(bracketed.start, bracketed.end) === "six seven.md"
    );
  }

  /* -- (2) code is documentation about links, not links -------------------- */

  {
    const fenced = "before\n```md\n[[inside]]\n```\n[[outside]]\n";
    check(
      "a fenced block is not scanned",
      parseLinks(fenced).map((l) => l.target).join() === "outside"
    );
    check(
      "a code span is not scanned",
      parseLinks("text `[[inside]]` and [[outside]]").map((l) => l.target).join() === "outside"
    );
    check(
      "a tilde fence is a fence",
      parseLinks("~~~\n[[inside]]\n~~~\n[[outside]]").map((l) => l.target).join() === "outside"
    );
    check(
      "a shorter fence does not close a longer one, and a longer one closes a shorter",
      parseLinks("````\n[[a]]\n```\n[[b]]\n````\n[[c]]").map((l) => l.target).join() === "c"
    );
    check(
      "an unterminated fence swallows the rest of the note",
      parseLinks("```\n[[a]]\n[[b]]").length === 0
    );
    check("code ranges come back sorted", (() => {
      const ranges = codeRanges("`a` text `b`\n```\nx\n```\n");
      return ranges.every((range, i) => i === 0 || range[0] >= ranges[i - 1][0]);
    })());
  }

  /* -- (3) resolution ------------------------------------------------------ */

  {
    const names = indexByName([NOTE, "2-products/context-lc/overview.md", "3-resources/unique-name.md"]);
    const resolve = (target, kind = "wiki") =>
      resolveLink({ kind, target }, NOTE, names);

    check(
      "the link from the bug report resolves to the note it names",
      resolve("../../2-products/context-lc/overview") === "2-products/context-lc/overview.md"
    );
    check("a rooted target resolves from the bucket root", resolve("2-products/context-lc/overview") === "2-products/context-lc/overview.md");
    check("an anchor does not change what a link resolves to", resolve("../../2-products/context-lc/overview#shape") === "2-products/context-lc/overview.md");
    check("`./` names this note's own folder", resolve("./sibling") === "1-projects/persistence/sibling.md");
    check("an inline target keeps its `.md`", resolve("../../2-products/context-lc/overview.md", "inline") === "2-products/context-lc/overview.md");
    check("a percent-encoded inline target is decoded first", resolve("../a%20b.md", "inline") === "1-projects/a b.md");

    check("an external URL is not ours", resolve("https://context.lc/x") === null);
    check("a protocol-relative URL is not ours", resolve("//evil.example/x") === null);
    check("a mail link is not ours", resolve("mailto:someone@example.com") === null);
    check("a same-note anchor is not a move's business", resolve("#heading") === null);
    check("an empty target resolves to nothing", resolve("") === null);

    check(
      "an attachment keeps its own extension rather than gaining `.md`",
      resolve("../../assets/diagram.png") === "1-projects/assets/diagram.png" ||
        resolve("./assets/diagram.png") === "1-projects/persistence/assets/diagram.png"
    );

    check(
      "a target that walks above the root resolves to nothing, and is not clamped",
      resolve("../../../../etc/passwd") === null
    );
    check("normalizeSegments refuses to escape rather than clamping", normalizeSegments(["..", "a"]) === null);

    check("a bare name with exactly one note is resolved", resolve("unique-name") === "3-resources/unique-name.md");
    check(
      "a bare name two notes answer to is left alone",
      resolveLink({ kind: "wiki", target: "overview" }, NOTE, indexByName([NOTE, "2-products/x/overview.md"])) === null
    );
    check("a bare name nothing answers to is left alone", resolve("nothing-here") === null);
  }

  /* -- (4) style is preserved --------------------------------------------- */

  {
    const at = "1-projects/persistence/overview.md";
    const target = "2-products/context-lc/overview.md";
    check(
      "a relative wikilink stays relative and drops `.md`",
      expressLink({ kind: "wiki", target: "../../2-products/x/overview" }, at, target) ===
        "../../2-products/context-lc/overview"
    );
    check(
      "a rooted wikilink stays rooted",
      expressLink({ kind: "wiki", target: "2-products/x/overview" }, at, target) ===
        "2-products/context-lc/overview"
    );
    check(
      "a bare wikilink stays bare",
      expressLink({ kind: "wiki", target: "overview" }, at, target) === "overview"
    );
    check(
      "an inline link keeps its `.md`",
      expressLink({ kind: "inline", target: "../../2-products/x/overview.md" }, at, target) ===
        "../../2-products/context-lc/overview.md"
    );
    check(
      "an anchor survives the rewrite",
      expressLink({ kind: "wiki", target: "../../2-products/x/overview#shape" }, at, target) ===
        "../../2-products/context-lc/overview#shape"
    );
    check(
      "a sibling gets `./` so it does not read as a bare name on the way back",
      expressLink({ kind: "wiki", target: "../sibling" }, at, "1-projects/persistence/sibling.md") ===
        "./sibling"
    );
    check(
      "a space in an inline target is encoded rather than ending the link",
      expressLink({ kind: "inline", target: "./a.md" }, at, "1-projects/persistence/a b.md") ===
        "./a%20b.md"
    );
    check("relativePath climbs out of a folder", relativePath("1-projects/a", "2-areas/b.md") === "../../2-areas/b.md");
    check("relativePath from the root is the path", relativePath("", "a/b.md") === "a/b.md");
    check("dirOf a root note is the root", dirOf("a.md") === "");
    check("styleOf tells the three apart", styleOf("./a") === "relative" && styleOf("a/b") === "rooted" && styleOf("a") === "bare");
  }

  /* -- (5) the rewrite itself --------------------------------------------- */

  {
    const moved = new Map([["2-products/context-lc/overview.md", "2-products/contextlc/readme.md"]]);
    const names = [NOTE, "2-products/context-lc/overview.md"];

    const both = rewrite(
      "see [[../../2-products/context-lc/overview]] and [x](../../2-products/context-lc/overview.md)",
      { renames: moved, names }
    );
    check(
      "a renamed note is followed by both link forms, and the count is the count",
      both?.text ===
        "see [[../../2-products/contextlc/readme]] and [x](../../2-products/contextlc/readme.md)" &&
        both.changed === 2
    );

    check(
      "an alias, an embed and an anchor survive being followed",
      rewrite("![[../../2-products/context-lc/overview|the app]] [[../../2-products/context-lc/overview#shape]]", {
        renames: moved,
        names,
      })?.text === "![[../../2-products/contextlc/readme|the app]] [[../../2-products/contextlc/readme#shape]]"
    );

    check(
      "nothing to do answers null rather than rewriting the file to itself",
      rewrite("see [[../../2-products/context-lc/overview]]", { names }) === null
    );
    check("a note with no links answers null", rewrite("plain text", { renames: moved, names }) === null);
    check(
      "a link inside a code fence is not followed",
      rewrite("```\n[[../../2-products/context-lc/overview]]\n```", { renames: moved, names }) === null
    );

    /*
      (3) in the file header, and the reason this module recomputes rather than
      substitutes. The referrer moved two levels deeper; nothing it points at
      moved at all, and every relative link it holds is now wrong by two `../`.
    */
    const carried = rewriteLinks("see [[../2-areas/practice]] and [[./sibling]]", {
      fromPath: "1-projects/a/note.md",
      toPath: "4-archive/2026/1-projects/a/note.md",
      renames: new Map([["1-projects/a/note.md", "4-archive/2026/1-projects/a/note.md"]]),
      byName: indexByName(["1-projects/2-areas/practice.md", "1-projects/a/sibling.md"]),
    });
    check(
      "a note carried by a folder move has its own relative links recomputed",
      carried?.text ===
        "see [[../../../../1-projects/2-areas/practice]] and [[../../../../1-projects/a/sibling]]"
    );

    check(
      "a rooted link in a note that moved is left byte-identical",
      rewriteLinks("see [[2-areas/practice]]", {
        fromPath: "1-projects/a/note.md",
        toPath: "4-archive/note.md",
        renames: new Map([["1-projects/a/note.md", "4-archive/note.md"]]),
        byName: indexByName(["2-areas/practice.md"]),
      }) === null
    );

    check(
      "a bare link is followed only when one note answers to the name",
      rewrite("[[overview]]", { renames: moved, names: ["2-products/context-lc/overview.md"] })?.text ===
        "[[readme]]" &&
        rewrite("[[overview]]", { renames: moved, names: [...names] }) === null
    );

    check(
      "an external link is never touched, whatever moved",
      rewrite("[docs](https://context.lc/2-products/context-lc/overview.md)", {
        renames: moved,
        names,
      }) === null
    );
  }

  /* ------------------------------- wired -------------------------------- */

  await runWiredChecks(check);
}

/* --------------------------------- wired --------------------------------- */

/**
 * The four tools, against a real worker over an in-memory bucket.
 *
 * Its own control plane and its own bucket: `test.mjs`'s fixture is a privacy
 * fixture with two hundred checks resting on its exact contents, and seeding
 * link bodies into it would make one suite's failure look like the other's.
 */
async function runWiredChecks(check) {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  const bucket = {
    async get(key) {
      if (!objects.has(key)) return null;
      const { bytes, etag } = objects.get(key);
      return {
        etag,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async put(key, value) {
      const bytes =
        typeof value === "string"
          ? encoder.encode(value)
          : value instanceof Uint8Array
            ? new Uint8Array(value)
            : new Uint8Array(value);
      const etag = `e${++etagCounter}`;
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    /*
      Flat, and deliberately: this is `test.mjs`'s stub, which is the one the
      whole gateway is proven against. A first draft of this file grew a
      `delimitedPrefixes` half that looked more like R2 and was wrong in the one
      way that matters — `listAllNoteKeys` came back holding only `index.md`,
      every move reported nothing to rewrite, and thirteen checks failed
      pointing at the feature rather than at the fixture.
    */
    async list({ prefix } = {}) {
      const listed = [...objects.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({
          key,
          size: objects.get(key).bytes.length,
          uploaded: new Date(),
          etag: objects.get(key).etag,
        }));
      return { objects: listed, truncated: false };
    },
  };

  const store = new R2Store(bucket);
  const controlPlane = createControlPlaneStub();
  /*
    Restored at the end of this function. The stub answers for the same origin
    the shared fixture's does, so leaving it installed would make every later
    call in `test.mjs` resolve against a plane that has never heard of its
    tokens — a suite that passes and takes the next one down with it.
  */
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_links", "links", {
    provider: "r2-binding",
    bindingName: "CONTEXT_BUCKET",
    capabilities: { conditionalWrite: true },
    status: "active",
  });
  const OWNER = "cat_test_links_owner_0000000000000000";
  const TEAM = "cat_test_links_team_00000000000000000";
  await controlPlane.addGrant({
    accessToken: OWNER,
    workspaceId: "ws_links",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_links_owner",
    userId: "user_links_owner",
  });
  await controlPlane.addGrant({
    accessToken: TEAM,
    workspaceId: "ws_links",
    // `editor`, not `member`: write access to somebody else's context is never
    // implied by read, and a `member` grant is refused the move before it can
    // reach the rewrite this check is about.
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_links_team",
    userId: "user_links_team",
  });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "CONTEXT_BUCKET",
    CONTEXT_BUCKET: bucket,
  };

  let id = 0;
  async function call(token, name, args = {}) {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
      { waitUntil() {} }
    );
    return (await res.json()).result;
  }
  const read = (key) => {
    const entry = objects.get(key);
    return entry ? new TextDecoder().decode(entry.bytes) : undefined;
  };

  await store.put(
    "privacy.md",
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n" +
      "```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  1-projects: team\n" +
      "  2-areas: team\n  2-areas/private: private\n  4-archive: team\n\nnote_overrides:\n```\n\n" +
      "<!-- END BRAIN PRIVACY RULES -->\n"
  );
  await store.put("index.md", "# manifest");
  await store.put("1-projects/alpha/overview.md", "# alpha\n\nsee [[../beta/notes]] and [[../../2-areas/practice]]\n");
  await store.put("1-projects/beta/notes.md", "# beta\n\npoints at [[../alpha/overview]] and [x](../alpha/overview.md)\n");
  await store.put("2-areas/practice.md", "# practice\n\nrooted link to [[1-projects/alpha/overview]]\n");
  await store.put("2-areas/private/secret.md", "# secret\n\nprivate note pointing at [[../../1-projects/alpha/overview]]\n");

  /* -- move_note: everything pointing at it follows ------------------------ */

  const moved = await call(OWNER, "move_note", {
    source: "1-projects/alpha/overview.md",
    destination: "1-projects/alpha/summary.md",
  });
  const movedText = moved?.content?.[0]?.text ?? "";
  check(
    "move_note reports how many references it rewrote",
    !moved?.isError && /references: 4 links updated in 3 notes/.test(movedText)
  );
  check(
    "a relative wikilink and a relative inline link both follow the rename",
    read("1-projects/beta/notes.md") ===
      "# beta\n\npoints at [[../alpha/summary]] and [x](../alpha/summary.md)\n"
  );
  check(
    "a rooted link follows the rename and stays rooted",
    read("2-areas/practice.md") === "# practice\n\nrooted link to [[1-projects/alpha/summary]]\n"
  );
  check(
    "an owner's move reaches the private note too",
    read("2-areas/private/secret.md") ===
      "# secret\n\nprivate note pointing at [[../../1-projects/alpha/summary]]\n"
  );
  check(
    "the note that moved keeps its own links working",
    read("1-projects/alpha/summary.md") ===
      "# alpha\n\nsee [[../beta/notes]] and [[../../2-areas/practice]]\n"
  );
  check(
    "and the rewrite leaves no snapshot behind it",
    // Version history is the customer's object versioning now — see
    // `docs/decisions/storage-and-credentials.md`. This write path landed the
    // same week the snapshots were removed from every other one, and a
    // `.history/` entry here would put the write amplification back for one
    // tool.
    ![...objects.keys()].some((key) => key.startsWith(".history/"))
  );

  /* -- move_folder: the notes inside it get their own links recomputed ----- */

  const folder = await call(OWNER, "move_folder", {
    source: "1-projects/alpha",
    destination: "4-archive/alpha",
  });
  check("move_folder reports its rewrite too", !folder?.isError && /references: \d+ links updated in \d+ notes/.test(folder?.content?.[0]?.text ?? ""));
  check(
    "a note carried by the folder move has its own relative links recomputed",
    read("4-archive/alpha/summary.md") ===
      "# alpha\n\nsee [[../../1-projects/beta/notes]] and [[../../2-areas/practice]]\n"
  );
  check(
    "and the notes pointing into the folder follow it",
    read("1-projects/beta/notes.md") ===
      "# beta\n\npoints at [[../../4-archive/alpha/summary]] and [x](../../4-archive/alpha/summary.md)\n"
  );

  /* -- privacy: a team caller's rewrite stops at what it can see ----------- */

  await store.put("2-areas/private/secret.md", "# secret\n\n[[../../1-projects/beta/notes]]\n");
  const teamMove = await call(TEAM, "move_note", {
    source: "1-projects/beta/notes.md",
    destination: "1-projects/beta/log.md",
  });
  check("a team caller may still move a team note", !teamMove?.isError);
  check(
    "and a private note it cannot see is not rewritten by it",
    read("2-areas/private/secret.md") === "# secret\n\n[[../../1-projects/beta/notes]]\n"
  );
  check(
    "nor is it counted in what the caller is told",
    /references: 1 link updated in 1 note/.test(teamMove?.content?.[0]?.text ?? "")
  );

  /* -- archive_note ------------------------------------------------------- */

  await store.put("1-projects/gamma/keep.md", "# keep\n\n[[../beta/log]]\n");
  const archived = await call(OWNER, "archive_note", { path: "1-projects/beta/log.md" });
  check(
    "archive_note rewrites the links into what it retired",
    !archived?.isError && /references: \d+ links? updated in \d+ notes?/.test(archived?.content?.[0]?.text ?? "")
  );
  check(
    "and the link now names where the note actually went",
    /^# keep\n\n\[\[\.\.\/\.\.\/4-archive\/.+\/1-projects\/beta\/log\]\]\n$/.test(read("1-projects/gamma/keep.md") ?? "")
  );

  restore();
}
