/**
 * `save_context` takes its destination from index.md's own procedure, and
 * `archive_note` never invents an archive folder a layout does not have. See
 * orientation.test.mjs for the module overview.
 */

import { isLogicalDeleteMarker } from "../../src/store/logicalDelete.js";
import { rpc, orientText, PRIVACY_MANIFEST, OWNER_TOKEN } from "./fixtures.mjs";

export async function runOrientationSaveAndArchiveChecks(check, harness) {
  const { bucket, env } = harness;

  // -- save_context takes its orders from index.md
  //
  // The destination used to be `4-archive/chat-history/`, hardcoded, which is
  // a folder a custom layout may never have made and a word ("archive") for
  // where things go to stop mattering. What the person wants done at the end
  // of a session is theirs to write, in the file they already own.
  const save = async (token, args) => {
    const { body } = await rpc(env, token, "tools/call", {
      name: "save_context",
      arguments: { platform: "claude", content: "## User\nhi\n\n## Assistant\nhello", ...args },
    });
    return body?.result?.content?.[0]?.text || "";
  };

  // No procedure yet, and this fixture's manifest declares no 4-archive: the
  // fallback must not invent one.
  const assumed = await save(OWNER_TOKEN, {});
  check(
    "with no procedure and no 4-archive, a session lands in the inbox",
    /^saved: 0-inbox\/sessions\/claude\//m.test(assumed)
  );
  check(
    "an assumed destination says it was assumed, and how to change it",
    assumed.includes("destination: assumed") && assumed.includes("## Save context")
  );

  bucket.seed(
    "index.md",
    "# The front page\n\nShipping the gateway.\n\n" +
      "## Save context\n\ndestination: 2-areas/sessions\n\n" +
      "Three bullets of what we decided. Only keep the transcript if I asked for it.\n\n" +
      "## Something else\n\nNot part of the procedure.\n"
  );

  const directed = await save(OWNER_TOKEN, {});
  check(
    "a destination in index.md decides where a session lands",
    /^saved: 2-areas\/sessions\/claude\//m.test(directed)
  );
  check(
    "a followed destination is reported as the user's, not assumed",
    directed.includes("from this context's own save procedure") &&
      !directed.includes("destination: assumed")
  );
  check(
    "the procedure's prose comes back with the confirmation",
    directed.includes("Three bullets of what we decided") &&
      !directed.includes("Not part of the procedure")
  );

  const oriented = await orientText(env, OWNER_TOKEN);
  check(
    "orient carries the save procedure so an agent knows it before it needs it",
    oriented.includes("## Before this session ends") &&
      oriented.includes("Three bullets of what we decided") &&
      oriented.includes("`2-areas/sessions/`")
  );
  check(
    "the user's own procedure comes before the generic contract",
    oriented.indexOf("## Before this session ends") < oriented.indexOf("## Working here")
  );

  // A path that does not survive normalization is a typo in a file the person
  // can see and fix. Writing their sessions somewhere adjacent to what they
  // asked for is the worst of the available outcomes, so it is refused and
  // the fallback stands.
  bucket.seed("index.md", "# Front\n\n## Save context\n\ndestination: ../../etc\n");
  const rejected = await save(OWNER_TOKEN, {});
  check(
    "a destination that is not a safe folder path is refused, not repaired",
    /^saved: 0-inbox\/sessions\/claude\//m.test(rejected) && rejected.includes("assumed")
  );
  bucket.seed("index.md", "# Front\n\n## Save context\n\ndestination: notes/one.md\n");
  check(
    "a destination naming a note rather than a folder is refused",
    /^saved: 0-inbox\/sessions\/claude\//m.test(await save(OWNER_TOKEN, {}))
  );

  // The rename must not cost anybody a session: a client holding the cached
  // tool list is still calling `archive_chat`, with `history` rather than
  // `content`.
  const { body: legacy } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "archive_chat",
    arguments: { platform: "codex", history: "## User\nold client" },
  });
  check(
    "the previous tool name and argument still save a session",
    /^saved: /m.test(legacy?.result?.content?.[0]?.text || "")
  );

  bucket.seed("index.md", "# The front page\n\nShipping the gateway.");

  // -- archive_note on a layout that has no archive
  //
  // This fixture's manifest deliberately declares no `4-archive`, which makes
  // it the case the tool used to get wrong: it would invent the folder, in a
  // bucket its owner also sees in Obsidian, to satisfy a destination the
  // owner never chose — the same layout assumption save_context and the
  // connect instructions were purged of.
  const { body: archiveRefusal } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "archive_note",
    arguments: { path: "2-areas/handbook.md" },
  });
  const refusalText = archiveRefusal?.result?.content?.[0]?.text || "";
  check(
    "archive_note refuses rather than inventing an archive on a custom layout",
    archiveRefusal?.result?.isError === true && refusalText.includes("no archive folder")
  );
  check(
    "the refusal points at move_note and the owner's own conventions",
    refusalText.includes("move_note") && refusalText.includes("conventions")
  );
  check(
    "and nothing was created or moved by the refusal",
    ![...bucket.objects.keys()].some((key) => key.startsWith("4-archive/")) &&
      bucket.objects.has("2-areas/handbook.md")
  );

  // -- archive_note on a layout whose archive is not `4-archive`
  //
  // The refusal above was right about a layout with no archive and wrong
  // about this one, which is the `company` preset — the DEFAULT for a shared
  // context. Its archive is `5-archive`, it is declared in the manifest and
  // visible in the owner's own root listing, and `archive_note` refused it
  // for ten days while `move_note` into the same folder worked fine.
  bucket.seed(
    "privacy.md",
    PRIVACY_MANIFEST.replace("  3-resources: team\n", "  3-resources: team\n  5-archive: team\n")
  );
  const { body: archivedFive } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "archive_note",
    arguments: { path: "2-areas/handbook.md" },
  });
  const fiveKey = [...bucket.objects.keys()].find((key) =>
    key.endsWith("/2-areas/handbook.md")
  );
  const { body: sourceAfterArchive } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "read_note",
    arguments: { path: "2-areas/handbook.md" },
  });
  check(
    "archive_note files into the archive this layout actually has",
    archivedFive?.result?.isError !== true &&
      fiveKey?.startsWith("5-archive/") &&
      isLogicalDeleteMarker(bucket.objects.get("2-areas/handbook.md")?.body) &&
      sourceAfterArchive?.result?.isError !== true &&
      sourceAfterArchive?.result?.content?.[0]?.text.includes(`path: ${fiveKey}`) &&
      sourceAfterArchive?.result?.content?.[0]?.text.includes("moved_from: 2-areas/handbook.md")
  );
  check(
    "and it did not invent a 4-archive beside it",
    ![...bucket.objects.keys()].some((key) => key.startsWith("4-archive/"))
  );
  // Idempotency across roots: the note is now in `5-archive`, and asking
  // again must not move it anywhere — least of all into a `4-archive` the
  // resolver would have preferred had one been declared.
  const { body: already } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "archive_note",
    arguments: { path: fiveKey },
  });
  check(
    "a note already in this context's archive is left alone",
    (already?.result?.content?.[0]?.text || "").includes("already archived") &&
      bucket.objects.has(fiveKey)
  );

  // Two archives, and the note is in the one the resolver does NOT prefer.
  // This is the case a single-archive fixture cannot reach: with `4-archive`
  // declared too, asking about only the write destination would call this
  // note unarchived and move it out of `5-archive` into `4-archive` — a
  // second archive hop for a note that was already put away. Measured: with
  // "already archived" narrowed to the write root, the suite stayed green
  // until this check existed.
  bucket.seed(
    "privacy.md",
    PRIVACY_MANIFEST.replace(
      "  3-resources: team\n",
      "  3-resources: team\n  4-archive: team\n  5-archive: team\n"
    )
  );
  const { body: alreadyAcrossRoots } = await rpc(env, OWNER_TOKEN, "tools/call", {
    name: "archive_note",
    arguments: { path: fiveKey },
  });
  check(
    "a note in a second archive is not re-archived into the preferred one",
    (alreadyAcrossRoots?.result?.content?.[0]?.text || "").includes("already archived") &&
      bucket.objects.has(fiveKey) &&
      ![...bucket.objects.keys()].some((key) => key.startsWith("4-archive/"))
  );
  bucket.seed("privacy.md", PRIVACY_MANIFEST);
}
