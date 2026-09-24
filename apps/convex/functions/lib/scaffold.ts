/**
 * Laying down a starting context in a bucket that does not have one.
 *
 * ## What this is allowed to do
 *
 * Write a handful of Markdown files at the root of the customer's bucket, with
 * **no key namespacing of any kind**. A note lives at `1-projects/foo.md`; the
 * manifest lives at `index.md`; the privacy manifest lives at `privacy.md`.
 * There is no `tenants/<id>/` and no `workspaces/<slug>/` — see CLAUDE.md,
 * "Tenancy is bucket-level, never prefix-level". The one prefix that ever
 * applies is the customer's own `rootPrefix`, and that is handled inside the
 * storage adapter, invisibly to everything here.
 *
 * ## What this is NOT allowed to do
 *
 * **Overwrite anything.** The primary case for connecting a bucket is not a
 * fresh one — it is an existing workspace that has been running for months and
 * must come across with zero migration and zero visible change. Scaffolding
 * such a bucket would, at best, replace a hand-curated `index.md`; at worst it
 * would replace `privacy.md` and silently reset every folder's visibility.
 *
 * So there are two independent guards, and either one alone would be enough:
 *
 *  1. **Layout detection.** Before writing anything, look at the bucket. If it
 *     already contains any non-plumbing object, this is somebody's context and
 *     we do not touch it.
 *  2. **Per-key existence.** Every single write is preceded by a `get`, and a
 *     key that already exists is skipped. Belt and braces, because guard 1 is
 *     a judgement call over a listing and guard 2 is not a judgement call at
 *     all.
 *
 * Guard 1 has one narrowing, for the case where the thing in the bucket is our
 * own half-written scaffold rather than somebody's workspace: see `resume` on
 * `scaffoldContext` and `hasForeignContent`. Guard 2 does not move.
 *
 * The residual race — an object created between the `get` and the `put` — is
 * retained for compatibility with older custom store implementations that do
 * not honor create-if-absent. The narrower vault importer uses the current
 * adapters' create-only operation; scaffolding still keeps its original two
 * guards because it also runs against legacy/self-hosted stores. The window is
 * one round trip, on the first connect of a bucket that was just observed to be
 * empty, so it is documented rather than defended.
 *
 * ## Why the privacy manifest format is copied rather than imported
 *
 * `privacy.md` is **on-bucket format**, and the gateway
 * (`apps/mcp/src/index.js`) is the thing that has to read it back. Its parser
 * is a module-private function, so it cannot be imported here — but the
 * format is not guesswork: `__tests__/scaffold.test.ts` extracts the gateway's
 * *actual* `parsePrivacyManifest` from its source and parses what this module
 * writes. If the two ever drift, that test fails.
 *
 * The renderer itself has since moved to `lib/privacy.ts`, which holds the
 * whole ported engine (parse, render, evaluate) and is differentially tested
 * against the gateway's real functions. This module keeps only the decision
 * about what a *starting* manifest says.
 *
 * ## Layout of this module
 *
 * Split into `lib/scaffold/` by responsibility — shared vocabulary
 * (`store.ts`), custom-folder validation (`customFolders.ts`), `privacy.md`
 * rendering (`privacyManifest.ts`), `index.md`/README rendering
 * (`readmes.ts`), the guessable-path list (`mandatedPaths.ts`), existing-bucket
 * detection (`detect.ts`) and the write loop itself (`run.ts`). This file is a
 * facade: every name it exported before the split it still exports, from the
 * same path.
 */

export type {
  ContextKind,
  CustomFolder,
  ScaffoldStore,
  StructureTemplate,
} from "./scaffold/store";
export { FOLDER_PURPOSE, INDEX_KEY, PARA_FOLDERS, PRIVACY_KEY } from "./scaffold/store";

export type { FolderRejection, FolderValidation } from "./scaffold/customFolders";
export {
  MAX_CUSTOM_FOLDERS,
  MAX_FOLDER_DESCRIPTION_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  validateCustomFolders,
} from "./scaffold/customFolders";

export { renderPrivacyManifest, renderPrivacyManifestForFolders } from "./scaffold/privacyManifest";

export { renderCustomFolderReadme, renderFolderReadme, renderIndex } from "./scaffold/readmes";

export {
  CALENDAR_PATHS,
  CAPTURE_SOURCE_FOLDERS,
  GENERIC_ROOT_KEYS,
  isProductMandatedPath,
  PRODUCT_MANDATED_PATHS,
  SESSION_FOLDERS,
} from "./scaffold/mandatedPaths";

export {
  DETECT_PAGE_CAP,
  DETECT_PAGE_SIZE,
  hasExistingContext,
  hasForeignContent,
  isPlumbingKey,
} from "./scaffold/detect";

export type { ScaffoldReason, ScaffoldResult } from "./scaffold/run";
export { ESSENTIAL_KEYS, scaffoldContext, scaffoldFiles } from "./scaffold/run";
