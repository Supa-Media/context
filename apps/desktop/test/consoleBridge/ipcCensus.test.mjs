/**
 * THE ipcMain CENSUS, and the version-7 local-agent channels it counts.
 *
 * Split out of `preloadContract.test.mjs` because the census's own lexer and
 * walk, with the reasoning for each shape it tried and rejected, is long
 * enough on its own to need the room. See `preloadContract.test.mjs` for the
 * suite's overall rationale and the sabotage record, and `fixtures.mjs` for
 * the shared fakes.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRIDGE_CHANNELS } from "@context/desktop-bridge";
import { mainBridge, sender, HANDLED } from "./fixtures.mjs";

export async function runIpcCensusChecks(check) {
  /*
    THE CENSUS: every `ipcMain` in this app, and how many are gated.
    ---------------------------------------------------------------------------

    A guard checks the channels it is on. Nothing checked whether a NEW channel
    had appeared beside them — and this app grew its IPC surface three times in
    a day.

    EVERY EARLIER SHAPE OF IT WAS A LOWER BOUND WEARING AN EQUALS SIGN, and
    the count of shapes is deliberately not written down here: three separate
    numbers for it were live in this file and in `docs/decisions/desktop.md` at
    once, which is the same staleness this census exists to catch, in the prose
    describing the census.

    The first read three files and one syntax. Measured, three forms grew the
    surface at 784 PASS / 0 FAIL: a registration in a file it did not read,
    `ipcMain` split across lines before `.on`, and `ipcMain.on.bind(ipcMain)`.

    The second accounted for every mention of the identifier, but classified
    "followed by `,` or `}`" as an import specifier — so `register(ipcMain, ch)`,
    `{ ipc: ipcMain }` and `Reflect.get(ipcMain, "on")` were all read as imports
    and passed at 905 / 0. `index.ts` already contains such a mention. It also
    stripped comments with a regex that a `//` inside a string literal fooled
    into eating the registration on the same line — a stripper whose failure
    direction is "delete the evidence" rather than "flag it".

    So: strings are removed before comments (a lexer, not a regex, because the
    two mislead each other), imports are removed as whole clauses rather than
    guessed at from punctuation, and every `ipcMain` that survives must be a
    form named here — a registration, a teardown, or the single hand-off to
    `createConsoleBridge`, which is itself counted so it cannot become two.
    Everything else reddens, including forms nobody predicted. MEASURED at
    baseline 906: a plain new `ipcMain.on` reddens 2, a registration in a new
    subdirectory with a new extension 2, a `//`-inside-a-string hiding place 2,
    and each of `.bind`, an argument, an object property and `Reflect.get`
    reddens 1 — with the offending mention named in the failure, because a
    census that says only "the number moved" leaves somebody grepping.

    An `import { ipcMain as … }` rename reddens, by name. An earlier version of
    this comment said it reddened nothing and called that legitimate — the hole
    described as the feature, which the block below already says in its own
    words while this sentence went on contradicting it.

    Recursive, and over every extension the bundler will load, because "under
    `src/main`" is what the sentence says and a non-recursive `.ts`-only scan is
    not that.

    What it is honest about: the sixteen `ipcMain` registrations are ungated,
    and they are safe because every window whose preload can send them loads
    this app's own HTML — not because their preload cannot send.
    `preload/index.ts` exposes twelve send verbs, `record` and `connect` among
    them.
  */
  {
    /*
      TWO SCOPES, BECAUSE THE TWO CHECKS CAN DO DIFFERENT THINGS.

      The raw count walks all of `src/` and the bundled packages with it: a
      registration in `src/core/` was measured invisible simply because the
      directory was not walked, and so was one in `packages/desktop-bridge/src/`,
      which esbuild pulls into this same bundle. A main-process module landing
      one level out is an accident rather than an attack. Counting bytes works
      anywhere, so there is no reason to stop at a boundary nobody maintains.

      The lexed classification stays on `src/main`, where it was written and
      where every mention is a registration, a teardown, an import or the
      hand-off. Pointed at `src/core` it reports `contract.ts` as ending mid
      block-comment — a lexer bug, on a file with no `ipcMain` in it at all, and
      the fourth time this lexer has been wrong about something. It is the
      diagnostic; the count is the guard.
    */
    const srcDir = new URL("../../src/", import.meta.url);
    const mainDir = new URL("../../src/main/", import.meta.url);
    /*
      WHAT THIS WALKS: this app's `src/`, and EVERY workspace package, found by
      reading the directory rather than by being told.

      esbuild bundles `src/main/index.ts` with only `electron` external, so a
      registration in a workspace package is a registration in the main process
      — `main/connect.ts` imports `@supa-media/context/src/oauth.js`, which
      is how that stopped being hypothetical.

      **Three shapes of this tried to model the bundle and all three were wrong
      in the same direction**, each one measured rather than argued: walking
      `<pkg>/src` missed a live registration in `plugins/context/bin`, which this
      app can deep-import; reading `dependencies` missed a package moved to
      `devDependencies`; and reading `apps/desktop/package.json` at all missed
      both a package reached *transitively* through another workspace package
      and one still imported after being dropped from the manifest. The
      manifest is a near-neighbour of what the bundler reads and never the same
      fact: esbuild resolves by **import**, not by dependency class or by
      distance.

      So this stops modelling the bundle. It reads `packages/` and walks all of
      it, which is **deliberately wider** than the main process: measured, a bit
      under half of what the walk covers is not in that bundle at all. (An
      earlier version said "most", which was a guess standing where a
      measurement belonged, in the paragraph about not guessing. The version
      after that printed the two file counts — and merging one day of `main`
      moved both of them, because nothing here asserts either number. A count
      in a comment is the same habit one paragraph up, one round later, so the
      ratio stays and the digits go.) Wider is the affordable mistake here: the
      cost is a false red when somebody writes the identifier in a package
      nothing imports, and what it buys is that no dependency edge, in either
      direction, can move first-party code out of the census. Nothing is
      hand-listed, so there is no list to go stale and nothing to throw about.

      `desktop-bridge/src/contract.ts` mentions the identifier in prose, which
      is why the total below is 28 rather than 27.
    */
    const repoRoot = new URL("../../../../", import.meta.url);
    const packagesDir = new URL("packages/", repoRoot);
    const bundled = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => new URL(`${entry.name}/`, packagesDir));

    /*
      Strings out first, then comments. A regex that strips comments before
      strings reads the `//` in a URL literal as a comment and deletes the rest
      of the line; a regex that strips strings first reads the `"` in a comment
      as a string. Only tracking both at once gets either right.
    */
    const code = (text) => {
      let out = "";
      let mode = "code";
      /*
        The last character that decides whether a `/` opens a REGEX or divides.
        Without this state a legitimate `const quoted = /["]/;` opens string
        mode on its own bracket and swallows the next registration whole —
        MEASURED at 906 PASS / 0 FAIL, which is the "delete the evidence"
        failure direction this lexer replaced a regex to avoid. A lexer without
        a regex state is a regex with extra steps.
      */
      let significant = "";
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        const next = text[i + 1];
        if (mode === "code") {
          if (c === "/" && next === "/") { mode = "line"; i += 1; continue; }
          if (c === "/" && next === "*") { mode = "block"; i += 1; continue; }
          /*
            A `/` after a value divides; after an operator or a bracket it opens
            a regex. **Neither direction is conservative**, and an earlier
            comment here claimed dividing was. It is not: mistaking a regex for
            a division leaves the regex body lexed as code, where a quote inside
            it opens a phantom string that swallows whatever comes next — which
            is exactly how `return /^[a-z']+$/i` hid a registration. Both
            mistakes hide code, in opposite files. That is why the count above
            does not lex, and why this remains a diagnostic rather than a guard.
          */
          if (c === "/" && significant !== "" && !/[A-Za-z0-9_$)\]]/.test(significant)) {
            mode = "regex";
            out += " ";
            continue;
          }
          if (c === '"' || c === "'" || c === "`") { mode = c; out += " "; continue; }
          out += c;
          if (!/\s/.test(c)) significant = c;
        } else if (mode === "line") {
          if (c === "\n") { mode = "code"; out += c; }
        } else if (mode === "block") {
          if (c === "*" && next === "/") { mode = "code"; i += 1; }
        } else if (mode === "regex") {
          if (c === "\\") { i += 1; continue; }
          if (c === "[") { mode = "class"; continue; }
          if (c === "/") { mode = "code"; significant = "x"; }
        } else if (mode === "class") {
          // A `/` inside a character class does not end the literal.
          if (c === "\\") { i += 1; continue; }
          if (c === "]") mode = "regex";
        } else {
          // inside a string: a backslash escapes the next character
          if (c === "\\") { i += 1; continue; }
          if (c === mode) { mode = "code"; significant = "x"; }
        }
      }
      return { text: out, ended: mode };
    };

    /*
      `node_modules` and `.git` at any depth, because walking a package root
      without them reads the whole store. **Nothing else**, and the two shapes
      that tried to skip more are why.

      The first skipped `dist`, `build` and `coverage` at every depth, and a
      review put a real registration in `src/main/dist/` — a hand-written source
      directory that merely shares a name with an output one — and watched it
      stay green while appearing in the bundler's own input list. The second
      narrowed that to a walked root's direct children, on the stated ground
      that "that is where a package's own build lands". **Both halves of that
      were false**: `scripts/build.mjs` writes to `apps/desktop/dist`, which is
      outside the walked `src/`, and no package under `packages/` has a build
      script at all. So it guarded nothing that exists while blinding twelve
      committable directories — `build/` and `coverage/` are not gitignored.

      A filter on a directory's NAME is not a filter on whether it is
      generated, and the honest conclusion is not a better name filter but no
      name filter. A genuine build output walked one day costs a false red,
      which is the direction this census already chose everywhere else.
    */
    const ALWAYS_SKIP = new Set(["node_modules", ".git"]);
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [new URL(entry.name, dir)];
        if (ALWAYS_SKIP.has(entry.name)) return [];
        return walk(new URL(`${entry.name}/`, dir));
      });

    /*
      THE WALK IS CHECKED HERE, NOT ONLY USED BELOW.

      Three shapes of this walk have been wrong, each one blind rather than
      noisy, and each one found by a person hand-writing a registration into a
      directory and watching the suite stay green. A hand-sabotage that is not
      committed proves the shape of the day and nothing about the next one, so
      the walk now runs against a tree built for the purpose: a file at the
      root, one under each of the three names two earlier shapes skipped, one
      under a nested `dist/`, and one under each of the two names that ARE
      skipped. Set equality, so a name silently added to `ALWAYS_SKIP` reddens
      exactly as a name silently removed from it does.

      The third check is the third shape stated as an assertion.
      `bundled.flatMap(walk)` handed the array index in as a second parameter,
      so the first package root was walked with a falsy `atRoot` and the rest
      with a truthy one, and the same registration reddened in one package and
      passed in another by `readdirSync` order. So the walk is called the way
      `flatMap` would call it — with an index — and has to answer the same
      thing. **Not `walk.length === 1`**: measured, the shape that carried the
      bug was `(dir, atRoot = true)`, and a defaulted parameter does not count
      toward `length`, so that check passes on the exact code it claims to
      refuse. A guard that cannot see the bug it is named for is the failure
      this whole file is a record of.
    */
    const probeRoot = mkdtempSync(join(tmpdir(), "console-census-walk-"));
    try {
      for (const relative of [
        "at-root.ts",
        "build/generated-name.ts",
        "coverage/generated-name.ts",
        "dist/generated-name.ts",
        "src/main/dist/nested.ts",
        "node_modules/a-package/index.ts",
        ".git/objects/blob.ts",
      ]) {
        const full = join(probeRoot, relative);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "// probe\n");
      }
      const probeUrl = pathToFileURL(`${probeRoot}/`);
      const found = walk(probeUrl)
        .map((file) => file.pathname.slice(probeUrl.pathname.length))
        .sort();
      check(
        `THE WALK SKIPS node_modules AND .git AND NOTHING ELSE — ${found.length} files, ${found.join(", ")}`,
        found.join("\n") ===
          ["at-root.ts", "build/generated-name.ts", "coverage/generated-name.ts", "dist/generated-name.ts", "src/main/dist/nested.ts"]
            .sort()
            .join("\n"),
      );
      check(
        "...so a registration in a directory NAMED like build output is still counted",
        found.includes("build/generated-name.ts") &&
          found.includes("coverage/generated-name.ts") &&
          found.includes("dist/generated-name.ts"),
      );
      const asFlatMapWouldCall = [0, 1, 4].map((index) =>
        walk(probeUrl, index, [])
          .map((file) => file.pathname.slice(probeUrl.pathname.length))
          .sort()
          .join("\n"),
      );
      check(
        "THE WALK ANSWERS THE SAME THING WHATEVER flatMap HANDS IT as an index",
        asFlatMapWouldCall.every((answer) => answer === found.join("\n")),
      );
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }

    let registrations = 0;
    let handoffs = 0;
    const unrecognised = [];
    for (const file of walk(mainDir)) {
      // Every extension the bundler will load, not just the ones in the tree today.
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file.pathname)) continue;
      // Import clauses whole, so `ipcMain` inside one is never guessed at from
      // the punctuation that happens to follow it.
      const raw = readFileSync(file, "utf8");
      /*
        A RENAMED IMPORT IS AN UNRECOGNISED FORM, not an ignored one.

        Deleting the import clause and then scanning for the identifier means a
        file that binds it under another name has no mentions left to find:
        `import { ipcMain as electronIpc }` followed by `electronIpc.on(...)`
        registered a channel at 906 PASS / 0 FAIL. The clause is where the
        aliasing happens, so the clause is where it has to be caught — and this
        branch's own comment used to call that silence "a legitimate rename
        reddens nothing", which was describing the hole as the feature.

        Refused rather than followed, because nothing in this app renames it and
        a census that tracks arbitrary local bindings is a parser. If somebody
        needs the rename, they change this check and say why.
      */
      for (const clause of raw.matchAll(/\bimport\s([^;]*?)\sfrom\s*["'`][^"'`]*["'`]\s*;/g)) {
        if (/\bipcMain\s+as\s+\w+/.test(clause[1])) {
          unrecognised.push(`${file.pathname.split("/").pop()}: ipcMain imported under another name`);
        }
      }
      // Import clauses go BEFORE the lexer, while their module specifier is
      // still a quoted string — the lexer replaces it with a space, and a regex
      // written for the stripped form would match a shape that only exists
      // after its own input has been mangled.
      const lexed = code(raw.replace(/\bimport\s[^;]*?\sfrom\s*["'`][^"'`]*["'`]\s*;/g, " "));
      if (lexed.ended !== "code") {
        unrecognised.push(`${file.pathname.split("/").pop()}: lexer ended in ${lexed.ended}`);
      }
      const text = lexed.text;
      for (const match of text.matchAll(/\bipcMain\b/g)) {
        const before = text.slice(Math.max(0, match.index - 12), match.index);
        const after = text.slice(match.index + "ipcMain".length, match.index + 40);
        if (/^\.removeAllListeners\(/.test(after)) continue;
        if (/^\.(?:on|once|handle)\(/.test(after)) { registrations += 1; continue; }
        // The one hand-off: `createConsoleBridge({ ipc: ipcMain, … })`.
        if (/\bipc:\s*$/.test(before) && /^\s*,/.test(after)) { handoffs += 1; continue; }
        unrecognised.push(`${file.pathname.split("/").pop()}: ipcMain${after.split("\n")[0]}`);
      }
    }

    const bridge = code(readFileSync(new URL("consoleBridge.ts", mainDir), "utf8")).text;
    const bridgeCalls = (bridge.match(/deps\.ipc\.(?:on|once|handle)\(/g) ?? []).length;
    const gatedAsync = (bridge.match(/\n {2}handle\(BRIDGE_CHANNELS\./g) ?? []).length;
    const gatedSync = (bridge.match(/\n {2}answerSync\(BRIDGE_CHANNELS\./g) ?? []).length;

    /*
      THE ONE ASSERTION THAT CANNOT BE FOOLED BY LEXING, because it does not lex.

      Every shape of this census so far has had holes, and two of them were in
      the lexer itself: a regex literal containing a quote swallowed the next
      registration, and the regex/division rule added to fix that opened the
      mirror-image hole. `return /^[a-z']+$/i` divides — the character before
      the slash is the `n` of `return` — so the apostrophe opens string mode, a
      later quote closes it, and an ungated registration in that file passed at
      916 PASS / 0 FAIL. Idiomatic TypeScript, not a contrivance.

      Telling a regex from a division needs a parser and this suite has no
      dependencies, so the load-bearing check stops trying. It counts every
      occurrence of the identifier in the raw bytes — comments and strings
      included — and requires the total. Nothing about how a file lexes can
      change that number.

      The cost is real and is the right way round: writing the identifier in a
      new comment reddens this, and the fix is to update the number on purpose.
      A guard that complains when the surface is DESCRIBED differently is
      cheaper than one that stays silent when the surface IS different.

      WHAT IT STILL CANNOT SEE, said plainly rather than claimed away. Every
      shape of this census so far has been described as exhaustive and none was,
      so this list is what a reviewer MEASURED rather than what its author
      believed:

        - **a registration that never spells the identifier.**
          `electron["ipc" + "Main"].on(...)` passes, and no text scan will ever
          catch it — the name is not in the bytes.
        - **an aliased receiver.** `const { ipc } = win.webContents;` followed by
          `ipc.handle(...)` spells neither `ipcMain` nor `.ipc.`, and was
          measured green. Telling that binding from any other `ipc` needs the
          import graph this suite does not have.

      Both need a real build step to close, and the list is written
      open-endedly because every closed form of it has been wrong — four
      rounds, and each round's new sentence was false in a way the round before
      had just claimed to fix.

      What reviews DID close, each by measuring the hole rather than arguing
      about it: `handleOnce` and `addListener`, because the method name was a
      list of three verbs; a registration in a workspace package, including one
      outside that package's `src/`, one reached only transitively, and one in
      a package the manifest had stopped naming — which is why the walk no
      longer reads a manifest at all; a source directory named `dist`, which a
      name-based skip could not tell from an output one; and a registration
      paid for by a balancing edit somewhere else, which is what the map above
      is for and what a bare total could never catch.

      So the claim is the smaller true one: **this guard is for the accident,
      not the adversary.** It catches a channel somebody adds without thinking
      about the gate, in every spelling anybody has actually written. It does
      not catch somebody hiding one on purpose. That is worth having and is not
      worth overstating.

      The classification below keeps its place as the diagnostic — it names
      which mention is unrecognised, which is what a person needs — but it is no
      longer what stands between a new ungated channel and a green run.
    */
    /*
      `webContents.ipc` AND `webFrameMain.ipc` ARE IPC TOO, and neither spells
      `ipcMain`. They are Electron's documented way to scope a channel to one
      window, so a registration through them is idiomatic rather than obscure —
      and it was invisible here until a review measured it.

      THE METHOD NAME IS NOT ENUMERATED, and the first version of this check
      enumerated it: `(?:on|once|handle)\(` is the three verbs somebody thought
      of, and `IpcMain` also declares `handleOnce`, `addListener`,
      `removeListener` and `off`. A review wrote `win.webContents.ipc.handleOnce(
      …)` into this tree and it passed green. So the name is now `[A-Za-z_$][\w$]*`
      — any member call on an `.ipc` receiver — which is a count of a surface
      rather than a list of the parts of it anybody remembered.
    */
    /*
      A TOTAL IS NOT A LOCATION, and two rounds of this census learned it the
      same way. `mentions === 28` and `scoped === 5` say how many there are and
      nothing about where, so a new registration passes green as long as
      something else in the walk shrinks by as much in the same commit. Both
      halves of that were MEASURED: a real `win.webContents.ipc.handle(...)` in
      a second file *named* `consoleBridge.ts` with one teardown call aliased
      away, and a re-export shim with one prose mention deleted to pay for it.
      The first defeated a locality check that keyed on the **basename**.

      So the census is a map, and the map is compared whole. Every file that
      mentions the identifier or calls through an `.ipc.` receiver is named
      here with its counts, by repository-relative path. A file added, removed,
      renamed, or changed in either count is a diff against this literal, so a
      balancing edit puts **both** of its halves in the drift list rather than
      cancelling out. (One red check with two entries, not two red checks, and
      the failure line prints the first of them. The totals say nothing in that
      case — measured, a balancing edit leaves both of them green, which is the
      entire reason this map exists.)
    */
    const CENSUS = {
      "apps/desktop/src/core/shell/bridge.ts": "1 mention, 0 ipc calls",
      "apps/desktop/src/core/shell/console.ts": "1 mention, 0 ipc calls",
      // 13, not 11: `#died()` — the capture-window-crashed handler this app's
      // zombie-recording fix added — calls `ipcMain.removeAllListeners` twice
      // on its way out, mirroring the same two calls `stop()` already made.
      // Neither is a registration; the census does not distinguish, by design.
      "apps/desktop/src/main/capture.ts": "13 mentions, 0 ipc calls",
      "apps/desktop/src/main/consoleBridge.ts": "3 mentions, 5 ipc calls",
      // 14, all of them moved here from `main/index.ts` when `main()` was split
      // by subject: the import, the bridge hand-off and the renderer's twelve
      // `on` registrations. The total and the per-kind counts did not move.
      "apps/desktop/src/main/windowIpc.ts": "14 mentions, 0 ipc calls",
      "packages/desktop-bridge/src/contract.ts": "1 mention, 0 ipc calls",
    };
    let mentions = 0;
    let scoped = 0;
    const census = {};
    for (const file of [...walk(srcDir), ...bundled.flatMap((dir) => walk(dir))]) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file.pathname)) continue;
      const raw = readFileSync(file, "utf8");
      const seen = (raw.match(/\bipcMain\b/g) ?? []).length;
      const calls = (raw.match(/\.ipc\.[A-Za-z_$][\w$]*\(/g) ?? []).length;
      mentions += seen;
      scoped += calls;
      if (seen === 0 && calls === 0) continue;
      /*
        Relative to the repository root, not to the first `apps/` or
        `packages/` segment in the absolute path. The regex form read the
        checkout: a clone at `/srv/apps/checkout` turned every key into
        `apps/checkout/…` and drifted all six. A false red rather than a false
        green, so it was never dangerous — but a guard that fails on somebody
        else's directory layout is a guard they will delete.
      */
      const relative = file.pathname.slice(repoRoot.pathname.length);
      census[relative] =
        `${seen} mention${seen === 1 ? "" : "s"}, ${calls} ipc call${calls === 1 ? "" : "s"}`;
    }
    // 31 and not 28: widening to `src/` picks up two mentions in prose, in
    // `core/shell/bridge.ts` and `core/shell/console.ts`, and widening to the
    // bundled packages picks up a third in `desktop-bridge/src/contract.ts` —
    // all three comments about this very guard. That is exactly the false
    // positive this check accepts by design: the number moves when the surface
    // is DESCRIBED differently, which is cheaper than silence when it IS
    // different.
    //
    // 33 and not 31: `main/capture.ts` gained two, both `ipcMain.removeAllListeners`
    // calls in `#died()` — the capture-window-crashed handler — mirroring the
    // pair `stop()` already made. Named rather than silently re-baselined,
    // per this file's own rule two paragraphs up: a number that moved because
    // the surface changed is the guard doing its job.
    //
    // "IN THE WALK" and not "IN THE MAIN BUNDLE", because the walk is a
    // directory list and the bundle is what esbuild resolves. They do NOT
    // agree even on this tree — 28 in the walk against 27 over the main
    // bundle's own inputs, the difference being `core/shell/bridge.ts`, which
    // esbuild puts in the console preload rather than the main bundle. An
    // earlier note here said they agree; it was asserted rather than measured,
    // which is the whole reason the check is named for the walk.
    check(
      `EVERY MENTION OF ipcMain IN THE WALK IS ACCOUNTED FOR — ${mentions} of 33`,
      mentions === 33,
    );
    /*
      Named for what it counts, after a review found the old name false twice
      over. It said PER-WINDOW and there are no per-window registrations in this
      tree: the two it matched are `deps.ipc.handle(` and `deps.ipc.on(` in
      `consoleBridge.ts`, and `deps.ipc` is handed the **global** `ipcMain` at
      `main/index.ts`. They match by shape. It also said "any third is new
      surface", and the widened method name makes it five — the same two helpers
      plus the bridge's own teardown calls, which are not registrations at all.

      So the claim is the one this can actually carry: every `.ipc.` member call
      **in the walk** is inside `consoleBridge.ts`, where the gate is. One
      written anywhere else moves the number, whichever verb it uses. "In the
      walk" and not "in the main bundle" for the reason the check above is
      named that way, and this sentence said the wrong one of those until a
      review read the two together.
    */
    check(
      `EVERY .ipc. CALL IN THE WALK IS IN THE GUARDED BRIDGE — ${scoped} of 5`,
      scoped === 5,
    );
    const censusDrift = [
      ...Object.keys(census).filter((path) => census[path] !== CENSUS[path]),
      ...Object.keys(CENSUS).filter((path) => census[path] === undefined),
    ];
    check(
      `AND EACH ONE IS IN THE FILE THE CENSUS SAYS${
        censusDrift.length ? ` — ${censusDrift[0]}: ${census[censusDrift[0]] ?? "gone"}` : ""
      }`,
      censusDrift.length === 0,
    );

    check(
      `EVERY \`ipcMain\` UNDER src/main IS A FORM THIS CENSUS RECOGNISES${unrecognised.length ? ` — ${unrecognised[0]}` : ""}`,
      unrecognised.length === 0,
    );
    /*
      SIXTEEN AND NOT FIFTEEN, MOVED ON PURPOSE.

      The fourth capture channel is `context:capture-level`, and it is in the
      same class as the three beside it: the hidden capture window's own,
      registered by `main/capture.ts` for the life of one recording and torn
      down with it. It is ungated for the reason those three are — reachable
      only from a window this app `loadFile`s — and the census exists so that
      moving this number is a sentence somebody wrote rather than a drift
      nobody looked at.

      What crosses it is two floats. A hostile sender on this channel can make
      a bar the wrong height on a screen its owner is already looking at, and
      nothing else: it opens no input, files no meeting, reaches no credential,
      and `main/capture.ts` clamps both numbers into 0-1 before they travel.
    */
  // -- the local agent, version 7 --------------------------------------------
  {
    const { ipc, asked } = mainBridge({ localAgent: { available: true, name: "Claude Code" } });

    const status = await ipc.handlers.get(BRIDGE_CHANNELS.agentStatus)(sender());
    check("the page can ask whether there is a CLI to ask", status.ok === true);
    check("...and is told", status.value.available === true && status.value.name === "Claude Code");

    await ipc.handlers.get(BRIDGE_CHANNELS.agentAsk)(sender(), {
      question: "what did I decide about pricing?",
      place: { context: "seyi", note: { path: "1-projects/pricing.md", visibility: "private", readable: true, unsaved: true }, meetingLive: false },
      // Planted: a field the page might one day keep on its own object. It
      // must not ride along, for `features/agent/gateway.ts`'s reason — what
      // leaves for a model is decided in one place, not by a spread.
      body: "THE WHOLE NOTE TEXT, WHICH MUST NOT TRAVEL",
    });
    check("the question reached the shell", asked.length === 1);
    check("...with the question", asked[0].question === "what did I decide about pricing?");
    check("...and the note as a reference", asked[0].place.note.path === "1-projects/pricing.md");
    check("...carrying whether the draft diverged", asked[0].place.note.unsaved === true);
    check(
      "NOTHING FROM THE PAGE RIDES ALONG UNINVITED",
      JSON.stringify(asked[0]).includes("MUST NOT TRAVEL") === false,
    );

    // A sender that is not the console gets nothing, like every other channel.
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.agentAsk)(sender({ id: 99 }), { question: "hi", place: {} });
    } catch {
      refused = true;
    }
    check("a frame that is not the console cannot ask", refused);
    check("...and the shell was never called for it", asked.length === 1);
  }

    check(
      "THE UNGATED SURFACE HAS NOT GROWN — twelve commands and four capture channels",
      registrations === 16,
    );
    check(
      "ipcMain is handed to exactly one thing, and that thing is the guarded bridge",
      handoffs === 1,
    );
    check(
      "the bridge reaches ipc through exactly its two guarded helpers, and nowhere else",
      bridgeCalls === 2,
    );
    check(
      "every channel the console bridge answers goes through one of them",
      gatedAsync === HANDLED.length && gatedSync === 2,
    );
    /*
      34 → 36: the two version-7 agent channels, both gated.

      Written out rather than bumped, as this check's own header asks. What
      they add to the reachable surface is a status read — a boolean and a
      name — and one question, which the shell answers by running the
      customer's own `claude` in an empty directory of ours. Neither channel
      reads a credential or hands one back: the grant is written to a 0600 file
      in the main process for the length of one run, and `main/localAgent.ts`
      unlinks it in a `finally`. A hostile sender on `agentAsk` can spend the
      machine owner's own subscription on a question of its choosing and read
      what their own context answers — which is the same authority the page
      already has through the connection, so the ceiling here is the sender
      check above rather than anything new.
    */
    check(
      "...and the census adds up, so neither side can drift unnoticed",
      registrations + gatedAsync + gatedSync === 36,
    );
  }
}
