/**
 * Which schema tables hold a parked third-party OAuth connect attempt.
 *
 * A connect attempt is a workspace-scoped row carrying an encrypted PKCE
 * verifier: half a live credential, parked between "the person left for the
 * provider's consent screen" and "the provider's callback proved it was
 * really them" — see `dropboxConnectAttempts` and `googleConnectAttempts` in
 * `schema.ts` for the argument in full. It lives minutes, not hours, and it
 * must not outlive the workspace that started it.
 *
 * ## Why this is derived rather than hand-listed
 *
 * `deleteWorkspaceCascade` (`functions/account.ts`) needs the complete set of
 * these tables, and a hand-maintained list is exactly the shape that grows a
 * silent gap: `dropboxConnectAttempts` was swept from the day account
 * deletion existed, `googleConnectAttempts` was not, for no reason other than
 * nobody added the second line when the second provider shipped — reviewed
 * and named as out of scope on the pull request that added the Google flow.
 * A third provider built the same way would repeat exactly that miss unless
 * the sweep stops depending on somebody's memory.
 *
 * So this module reads the schema's own validators instead: every
 * `defineTable` that declares BOTH a `workspaceId` field and an
 * `encryptedVerifier` field is a parked connect attempt, full stop. Both
 * fields are load-bearing to the definition, not incidental: `workspaceId` is
 * what makes a row somebody's to delete, and `encryptedVerifier` is what
 * makes it a live half-credential rather than an ordinary workspace-scoped
 * row (`storageBindings`, `ingestionSettings`, and a dozen others all have
 * `workspaceId` and are not connect attempts). A future Slack or Notion
 * connect attempt built on the same shape lands in this set the moment its
 * table is declared, with nothing for that pull request to remember to add
 * here.
 *
 * `connectAttempts.test.ts` is this module's own self-test — the same
 * discipline `structure.test.ts` applies to `encryptedColumnsIn`, for the
 * same reason (`docs/decisions/testing.md`, "A guard nobody has checked is
 * not a guard"): a derivation that has never been shown to catch a table it
 * was not told about is not proven to catch the next one either.
 */
import schema from "../../schema";
import type { TableNames } from "../../_generated/dataModel";

/** The shape a `v.object(...)` validator exposes at runtime (`convex/values`). */
interface ObjectValidatorShape {
  kind: "object";
  fields: Record<string, unknown>;
}

function isObjectValidator(value: unknown): value is ObjectValidatorShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "object" &&
    typeof (value as { fields?: unknown }).fields === "object" &&
    (value as { fields?: unknown }).fields !== null
  );
}

/**
 * The real shape `defineTable(...)` returns: a `TableDefinition` whose
 * `.validator` is the object (or union) validator passed to it. Typed
 * narrowly to the one property this module reads, so a schema-internal
 * refactor that leaves `.validator` alone does not require touching this
 * file even if it renames everything else on the class.
 */
type SchemaTables = Record<string, { validator: unknown }>;

/**
 * Walk every table in the schema and return the ones shaped like a parked
 * connect attempt.
 *
 * Takes the table map as a parameter — defaulted to the real schema — purely
 * so `connectAttempts.test.ts` can feed it a synthetic table map containing a
 * table this codebase does not have, and prove the derivation notices it. A
 * derivation exercised only against the schema that already passes it has
 * not been shown to catch anything.
 */
export function connectAttemptTables(tables: SchemaTables = schema.tables): TableNames[] {
  const found: TableNames[] = [];
  for (const [tableName, table] of Object.entries(tables)) {
    if (!isObjectValidator(table.validator)) continue;
    const { fields } = table.validator;
    if ("workspaceId" in fields && "encryptedVerifier" in fields) {
      found.push(tableName as TableNames);
    }
  }
  // Sorted so the result does not depend on `schema.ts`'s declaration order —
  // `Object.entries` over a plain object is insertion-order in practice, but
  // nothing here should rely on that.
  return found.sort();
}

/** The discovered set, computed once against the real schema. */
export const CONNECT_ATTEMPT_TABLES: readonly TableNames[] = connectAttemptTables();
