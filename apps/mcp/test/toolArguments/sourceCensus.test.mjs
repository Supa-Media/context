/**
 * Section 3, first half: the census read out of the gateway's source — the
 * dispatch switch, the alias table and the unlisted set, each read from the one
 * module that declares it (see ../gatewaySource.mjs). What it reads is left on
 * `harness` for the live half.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import {
  gatewaySourceFiles,
  soleSource,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentSourceCensusChecks(check, harness) {
  /* ================== 3. the census, read out of the source =============== */

  /*
    Where the census reads from. Each piece is named by the module that holds
    it, and that module must be the ONLY file under `src/` declaring it
    (`gatewaySource.mjs`): code that moves without this moving, or a second
    copy left behind, reads as "" and fails the checks below rather than
    letting them read a stale copy.
  */
  const GATEWAY = gatewaySourceFiles();
  const DISPATCH = soleSource(
    GATEWAY,
    /^(?:export )?async function callTool\(name, args, store, scope\)/m,
    "tools/dispatch.js"
  );
  const SESSION = soleSource(
    GATEWAY,
    /^(?:export )?async function callToolForSession\(params, store, session\)/m,
    "tools/session.js"
  );
  const ALIASES = soleSource(GATEWAY, /^(?:export )?const TOOL_NAME_ALIASES\b/m, "tools/advertised.js");
  const UNLISTED = soleSource(GATEWAY, /^(?:export )?const UNLISTED_TOOLS\b/m, "tools/advertised.js");
  for (const [what, found] of [
    ["callTool", DISPATCH],
    ["callToolForSession", SESSION],
    ["TOOL_NAME_ALIASES", ALIASES],
    ["UNLISTED_TOOLS", UNLISTED],
  ]) {
    if (!found.ok) console.log(`  census: ${what} is not declared once where expected (found in: ${found.where})`);
  }

  /** The body of one top-level function, by name. */
  function functionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) return "";
    const end = source.indexOf("\n}\n", start);
    return end === -1 ? "" : source.slice(start, end);
  }

  const dispatchBody = functionBody(DISPATCH.text, "async function callTool(name, args, store, scope)");
  const dispatched = [...dispatchBody.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]);
  // The parser's own self-test. A census built on a regex that silently
  // matched nothing would pass every check below by finding no tools at all,
  // which is the failure mode `docs/decisions/testing.md` was written about.
  check(
    "the dispatch-table parser finds the switch it is aimed at",
    dispatched.length >= 25 &&
      dispatched.includes("orient") &&
      dispatched.includes("export_encryption_keys") &&
      !dispatched.includes("no_such_tool_anywhere")
  );

  /*
    Every case in that switch is a literal name, which is what makes reading
    them off the source a census rather than a sample.

    This is the one hole the change that added this file named and left open:
    the parser above matches `case "some_name":`, so a case whose label is a
    variable or a template string dispatches a tool the census never sees, and
    every check below would pass while saying nothing about it. Nothing in the
    tree does that today, and the cheapest way to keep it that way is to
    require every label in the block to be a lowercase string literal rather
    than to hope. A `case name:` fails here, in the same run that would
    otherwise have silently stopped counting it.
  */
  const caseLabels = [...dispatchBody.matchAll(/^\s*case ([^\n]*):$/gm)].map((m) => m[1].trim());
  const computedCases = caseLabels.filter((label) => !/^"[a-z_]+"$/.test(label));
  check(
    `every case in the dispatch table is a literal name the census can read (${computedCases.join(", ")})`,
    caseLabels.length === dispatched.length && computedCases.length === 0
  );

  const aliasBlock = ALIASES.text.slice(
    ALIASES.text.indexOf("const TOOL_NAME_ALIASES"),
    ALIASES.text.indexOf("const TOOL_NAME_ALIASES") + 400
  );
  const aliases = new Map(
    [...aliasBlock.matchAll(/\["([a-z_]+)",\s*"([a-z_]+)"\]/g)].map((m) => [m[1], m[2]])
  );
  check(
    "the alias table is read, and holds the one unlisted name still dispatched",
    aliases.get("archive_chat") === "save_context"
  );

  /*
    The other way a name leaves `tools/list` without leaving the server.

    An alias sends one name to another tool's schema. `UNLISTED_TOOLS` keeps a
    tool's own definition and its own dispatch case and merely stops offering
    it — so the census below has to count it as covered, and the call at the
    end of this file has to still work. Read off the source for the same
    reason the dispatch table is: a set nobody reads is a set that can be
    emptied without a single check noticing.
  */
  const unlistedBlock = UNLISTED.text.slice(
    UNLISTED.text.indexOf("const UNLISTED_TOOLS"),
    UNLISTED.text.indexOf("const UNLISTED_TOOLS") + 200
  );
  const unlisted = new Set(
    [...unlistedBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
  );
  check(
    "the unlisted set is read, and holds create_form",
    unlisted.has("create_form") && dispatched.includes("create_form")
  );

  Object.assign(harness, { GATEWAY, SESSION, functionBody, dispatched, aliases, unlisted });
}
