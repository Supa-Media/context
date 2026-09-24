/**
 * The arguments of a tool call, against the schema the gateway advertised.
 *
 * This suite exists because of what an adversarial review of the encryption
 * key export found: the reviewer was checking whether `export_encryption_keys`
 * could be pointed at another workspace by supplying that workspace's
 * identifiers, and the only reason "this tool takes no arguments" was true is
 * that its two implementing functions do not declare an `args` parameter.
 * Nothing enforced the `inputSchema` the gateway publishes in `tools/list`.
 *
 * That is a property of the dispatch path, not of one tool, and the callers
 * are AI clients driven by text other people wrote. So there are three kinds
 * of check here and they answer three different questions:
 *
 *   - **The validator itself** — does it refuse what it claims to refuse, on
 *     the JSON Schema subset the tool definitions use, including the shapes
 *     that cost CPU rather than the ones that look wrong.
 *   - **The census** — is every tool in the dispatch table actually covered.
 *     Read out of the source, so a tool added next year cannot skip the
 *     validator by being added in the obvious place. `docs/decisions/testing.md`:
 *     a guard nobody has checked is not a guard, and one that checks a list
 *     somebody has to remember to update is checking the list.
 *   - **The attack** — another workspace's identifiers smuggled onto every
 *     tool the gateway offers, and the refusal that answers it disclosing
 *     nothing about whether that workspace exists.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured
 * rather than as expected:
 *
 * 1. **The validator call is deleted from `callToolForSession`** — 30 checks
 *    failed: 26 here, and 4 elsewhere that were written against the old
 *    behaviour and now depend on the new one, including both halves of the
 *    smuggled-argument attack in `encryptionGateway.test.mjs` and the
 *    passphrase a client volunteered.
 * 2. **`additionalProperties` is ignored** (the unknown-property loop is
 *    skipped) — 32 checks failed. The census still passed, and that is the
 *    point of having both: the census asks whether every tool is *reached*,
 *    never what the validator then does.
 * 3. **The `required` loop is removed** — 3 checks failed, including
 *    `read_image` called without a note over in `test.mjs`.
 * 4. **Type checking is removed** — 10 checks failed.
 * 5. **The node budget is raised a ten-thousandfold** — 2 checks failed: the
 *    oversized array, and the check that pins the budget itself. The first
 *    attempt at this sabotage set it to `Infinity` and failed *nothing*,
 *    because the fixtures were sized at `VALIDATION_NODE_BUDGET * 3` and threw
 *    a RangeError instead; that is recorded in the fixture below rather than
 *    quietly fixed, because it is the same lesson as rule 4 of
 *    `scripts/check-no-identifiers.mjs`.
 * 6. **The masked-tool skip is removed**, so a masked tool is validated like
 *    any other — 2 checks failed, both existence-oracle ones: a team-tier
 *    caller could tell `export_encryption_keys` from an invented name by the
 *    shape of the complaint.
 * 7. **The census's dispatch-table parser is pointed at a function that does
 *    not exist** — 1 check failed, the parser's own self-test, which is the
 *    only thing standing between a census and a regex that matches nothing.
 *
 * Re-measured by an adversarial review, which reproduced all seven counts
 * exactly and confirmed that sabotage 5 at `Infinity` now fails 2 checks
 * rather than throwing a RangeError. Five more, for the checks that review
 * added:
 *
 * 8. **A `case` is added to the dispatch table for a tool nothing advertises**
 *    — 1 check failed, "every tool in the dispatch table has an advertised
 *    inputSchema".
 * 9. **A second dispatch site is added**, the modern era calling `callTool`
 *    directly — 5 checks failed: "exactly one place a tool is dispatched
 *    from", the new modern-era argument check, and three pre-existing
 *    cross-era ones in `crossContext.test.mjs`.
 * 10. **A `case` label is made a constant rather than a literal** — 1 check
 *    failed, and it names the identifier. Without it the census silently stops
 *    counting that tool, which is the hole the change adding this file named.
 * 11. **`additionalProperties: false` is removed from `move_notes`' element
 *    schema** — 2 checks failed, and only one of them is behavioural: the
 *    census names the node (`move_notes.moves[]`), which is what a *new*
 *    array-of-objects tool with the same mistake would get, having no
 *    behavioural test of its own.
 * 12. **`hasOwnProperty.call` becomes a bare `key in properties`** — 2 checks
 *    failed, including `__proto__` sent as bytes over the wire.
 *
 * A thirteenth, added with the member-refusal checks below, and the first that
 * sabotages a *list* rather than a code path:
 *
 * 13. **A writing tool is added to `FORM_TOOLS`**, the set exempted from the
 *    write-scope gate. Before those checks existed: `move_note`,
 *    `archive_note`, `set_visibility` and `move_folder` each failed
 *    **nothing** — only `write_note` was held, and by other checks. After,
 *    each fails 1. An exemption list is the one kind of list where a wrong
 *    entry grants rather than refuses, so it is worth a check that does not
 *    read it.
 */

import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  S3_ENDPOINT,
  createControlPlaneStub,
  createS3Backend,
} from "./toolArguments/fixtures.mjs";
import { runToolArgumentValidatorChecks } from "./toolArguments/validator.test.mjs";
import { runToolArgumentSourceCensusChecks } from "./toolArguments/sourceCensus.test.mjs";
import { runToolArgumentCensusChecks } from "./toolArguments/census.test.mjs";
import { runToolArgumentAttackChecks } from "./toolArguments/attack.test.mjs";
import { runToolArgumentProtocolEraChecks } from "./toolArguments/protocolEras.test.mjs";
import { runToolArgumentRoutingChecks } from "./toolArguments/routing.test.mjs";

/**
 * The checks themselves live in `toolArguments/*.test.mjs`, split by behaviour
 * and run here in their original order against one control plane and one S3
 * backend; `harness` carries what an earlier section established.
 *
 * @param {(label: string, ok: boolean) => void} check
 */
export async function runToolArgumentChecks(check) {
  await runToolArgumentValidatorChecks(check);

  const harness = {};
  await runToolArgumentSourceCensusChecks(check, harness);

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  };

  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  try {
    Object.assign(harness, { env, s3, controlPlane });
    await runToolArgumentCensusChecks(check, harness);
    await runToolArgumentAttackChecks(check, harness);
    await runToolArgumentProtocolEraChecks(check, harness);
    await runToolArgumentRoutingChecks(check, harness);
  } finally {
    restoreControlPlane();
    restoreS3();
  }
}
