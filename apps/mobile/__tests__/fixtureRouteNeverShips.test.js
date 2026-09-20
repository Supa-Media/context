const fs = require("node:fs");
const path = require("node:path");
const { describe, expect, test } = require("@jest/globals");

/**
 * `/e2e-fixture` RENDERS IN EXACTLY ONE BUILD, AND IT IS NOT ONE THAT SHIPS.
 *
 * ## Why this file exists
 *
 * `app/e2e-fixture.tsx` is an editable console mounted on demo data, in the
 * shipped app tree. What keeps it out of every real export is one comparison
 * against an `EXPO_PUBLIC_*` variable, inlined at export time — unset, the
 * route is a redirect to `/` and behaves exactly as if it did not exist.
 *
 * The route's own header says every real export leaves that variable unset,
 * and until this file that sentence was enforced by **review**. Nothing failed
 * if a future workflow copied the line out of `package.json`'s
 * `build:e2e-web`, and the thing that would ship is a console anybody can open
 * in a browser. A security review named this gap, in one sentence, with this
 * file's name in it, and then re-listed it for several passes instead of
 * writing it — twice over, the same review watched somebody else write a guard
 * it had already specified. So: the guard.
 *
 * ## Two assertions, because one of them is vacuous alone
 *
 * Asserting "no deploy workflow mentions `EXPO_PUBLIC_E2E_FIXTURE`" passes
 * trivially the day somebody renames the variable — the string is gone from
 * the workflows because it is gone from everywhere. So the name is **read out
 * of the route** rather than written here, and the workflows are checked for
 * whatever the route actually gates on today. The guard and the code it guards
 * share one source for the fact they both depend on.
 *
 * The second assertion is the positive half: exactly one workflow may set it,
 * and it is `ci.yml`'s WebKit job. A guard that only forbids cannot tell
 * "nobody sets it" from "the route stopped being gated at all".
 */
describe("the e2e fixture route ships disabled", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const routeSource = fs.readFileSync(
    path.join(repoRoot, "apps/mobile/app/e2e-fixture.tsx"),
    "utf8",
  );

  /** The variable the route actually compares, not one this test remembers. */
  const gateName = (() => {
    const match = /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/.exec(routeSource);
    return match ? match[1] : null;
  })();

  const workflowsDir = path.join(repoRoot, ".github/workflows");
  const workflows = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(workflowsDir, name), "utf8") }));

  test("the route is gated on an EXPO_PUBLIC_ variable at all", () => {
    // If this fails the rest of the file is measuring nothing: either the gate
    // was removed, or it stopped being build-time-inlined.
    expect(gateName).not.toBeNull();
    expect(routeSource).toMatch(/<Redirect href="\/" \/>/);
  });

  test("no workflow but ci.yml sets it", () => {
    const setters = workflows
      .filter(({ source }) => source.includes(gateName))
      .map(({ name }) => name)
      .sort();
    expect(setters).toEqual(["ci.yml"]);
  });

  test("in particular, no deploy workflow sets it", () => {
    // Stated separately from the line above because this is the sentence the
    // route's header makes, and a reader looking for it should find it whole.
    const deployers = workflows
      .filter(({ name }) => name.startsWith("deploy-"))
      .filter(({ source }) => source.includes(gateName))
      .map(({ name }) => name);
    expect(deployers).toEqual([]);
  });
});
