/**
 * The rules a bucket's `privacy.md` says, as the tree's mirror keeps them. Test-only:
 * a fixture that seeds a bucket reads the rules it seeded to give a served tree the
 * rules it would have mirrored. Production never reads the file this way.
 */

import { loadPrivacyState } from "../functions/lib/fileOps/privacyState";
import type { FileStore } from "../functions/lib/fileOps/store";
import type { PrivacyMirror } from "../functions/lib/nodes/table";

export async function privacyMirrorOf(store: Pick<FileStore, "get">): Promise<PrivacyMirror> {
  const state = await loadPrivacyState(store as FileStore);
  return {
    ...(state.etag === null ? {} : { etag: state.etag }),
    invalid: state.invalid,
    folders: state.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
    notes: [...state.overrides].map(([path, visibility]) => ({ path, visibility })),
  };
}
