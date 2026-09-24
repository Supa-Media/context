/**
 * Scaffolding a new context.
 *
 * Two things must hold, and the second one matters more than the first:
 *
 *  1. A fresh bucket comes out with a layout the **gateway** can read — proved
 *     against the gateway's real `privacy.md` parser, not against a copy of
 *     what we think it wants.
 *  2. A bucket that already holds someone's context comes out **byte-identical**.
 *     Connecting an existing workspace is the primary case, not the edge case: the
 *     founder's own bucket has been live since August, is synced to Obsidian,
 *     and must connect with nothing changed and nothing migrated.
 */

import {
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
} from "../../functions/lib/scaffold";

export const FAKE_BUCKET = "example-context-bucket";
export const FAKE_S3 = {
  endpoint: "https://accountid.r2.cloudflarestorage.example/",
  region: "auto",
  bucket: FAKE_BUCKET,
  accessKeyId: "EXAMPLEACCESSKEYID00",
  secretAccessKey: "example-secret-access-key-not-real-000000",
};

/**
 * Somebody's workspace, as it looked before we ever touched it: a hand-written
 * privacy manifest with real sharing decisions in it, a hand-written index, and
 * notes. Module-scope because the resume tests further down have to prove this
 * bucket is refused too — a scaffold that can be finished must not become a way
 * into a vault that was here first.
 */
export function seedLiveWorkspace(store: { seed(key: string, body: string): void }): void {
  store.seed(
    PRIVACY_KEY,
    [
      "---",
      "role: privacy-manifest",
      "version: 1",
      "---",
      "",
      // Verbatim from a bucket that has been running since before the word
      // "brain" was retired. A fixture of a live vault that stops looking like
      // the live vaults it stands for has stopped testing anything.
      "# Brain Privacy Map",
      "",
      "<!-- BEGIN BRAIN PRIVACY RULES -->",
      "",
      "```yaml",
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  1-projects/private: private",
      "  2-areas: team",
      "  2-areas/health: private",
      "  index.md: team",
      "",
      "note_overrides:",
      "  1-projects/secret-plan.md: private",
      "```",
      "",
      "<!-- END BRAIN PRIVACY RULES -->",
      "",
    ].join("\n"),
  );
  store.seed(INDEX_KEY, "# My workspace\n\nHand-written manifest.\n");
  store.seed("1-projects/ship-the-thing.md", "# Ship the thing\n");
  store.seed("1-projects/secret-plan.md", "# Secret plan\n");
  store.seed("2-areas/health/notes.md", "# Health\n");
  store.seed("0-inbox/README.md", "my own inbox readme, not yours\n");
  store.seed("4-archive/2024/old.md", "# Old\n");
}


/* -------------------------------------------------------------------------- */
/*                     a scaffold that only partly lands                      */
/* -------------------------------------------------------------------------- */

export const PARA_READMES = PARA_FOLDERS.map((folder) => `${folder}/README.md`);
