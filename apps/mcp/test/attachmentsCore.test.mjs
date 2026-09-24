import { check, rpc, call, succeeded, contextStore, objects, controlPlane, modernFetch } from "./harness.mjs";
import {
  PNG_BYTES,
  PNG_BASE64,
  TEAM_IMAGE,
  PRIVATE_IMAGE,
  ORPHAN_IMAGE,
  SHARED_IMAGE,
  SCRIPT_OBJECT,
  REFUSAL,
  refusalText,
} from "./attachmentsFixtures.mjs";

export async function runAttachmentsCoreChecks() {

  // -- images: resolve-by-reference over an opaque, unlistable store
  //
  // The calendar cron checks above replace globalThis.fetch to serve an ICS feed;
  // these checks authenticate for real, so the control plane goes back first.
  controlPlane.install();
  //
  // The premise of the whole feature. `.context/assets/images/` is plumbing, so it is invisible
  // to every listing and unreadable by every note tool — that part is free. What
  // is not free is reaching an image *at all* without reopening any of it, and
  // this is the only path that does: name a note you can already see, and that
  // note must name the image.
  //
  // Every refusal below is the same three bytes. "no such image", "no such note",
  // "you cannot see that note" and "that note does not reference this image" must
  // be indistinguishable, or the tool becomes an existence oracle over a store
  // whose entire point is that it cannot be enumerated.

  for (const leaf of [TEAM_IMAGE, PRIVATE_IMAGE, ORPHAN_IMAGE, SHARED_IMAGE, SCRIPT_OBJECT]) {
    await contextStore.put(`.context/assets/images/${leaf}`, PNG_BYTES);
  }
  // Markdown inside the image store. Not note surface, at any scope: it must be
  // unlistable and unsearchable exactly like the binaries beside it.
  await contextStore.put(".context/assets/images/stray.md", "# IMAGESTOREMARKER\n");
  // 1-projects is a team-default folder; 1-projects/secret-thing is private.
  await contextStore.put(
    "1-projects/portable/with-image.md",
    `# team note\n\n![a screenshot](.context/assets/images/${TEAM_IMAGE})\n`
  );
  await contextStore.put(
    "1-projects/secret-thing/with-image.md",
    `# private note\n\n![a screenshot](.context/assets/images/${PRIVATE_IMAGE})\n`
  );
  // One image, two notes, two visibilities. The consequence is asserted below
  // rather than left to be discovered.
  await contextStore.put(
    "1-projects/portable/shared-image.md",
    `# team half\n\n![shared](.context/assets/images/${SHARED_IMAGE})\n`
  );
  await contextStore.put(
    "1-projects/secret-thing/shared-image.md",
    `# private half\n\n![shared](.context/assets/images/${SHARED_IMAGE})\n`
  );
  await contextStore.put(
    "1-projects/portable/with-script.md",
    `# team note\n\n[not an image](.context/assets/images/${SCRIPT_OBJECT})\n`
  );
  await contextStore.put("1-projects/portable/no-image.md", "# team note with no image at all\n");

  const imageTools = await rpc("priv-token", "tools/list");
  check(
    "read_image is discoverable and read-only",
    imageTools.result?.tools.find((tool) => tool.name === "read_image")?.annotations?.readOnlyHint === true
  );
  check(
    "a read-only grant may still resolve images",
    (await modernFetch({ method: "tools/list", token: "readonly-token" })).body.result?.tools.some(
      (tool) => tool.name === "read_image"
    )
  );

  const okImage = await call("priv-token", "read_image", {
    note: "1-projects/portable/with-image.md",
    image: `.context/assets/images/${TEAM_IMAGE}`,
  });
  const okImageBlock = okImage.content?.find((block) => block.type === "image");
  check(
    "a note the caller can see resolves the image it references",
    !okImage.isError && okImageBlock?.mimeType === "image/png"
  );
  check(
    "the bytes survive the round trip exactly",
    okImageBlock?.data === PNG_BASE64
  );
  check(
    "the leaf alone resolves as well as the full plumbing path",
    (await call("priv-token", "read_image", {
      note: "1-projects/portable/with-image.md",
      image: TEAM_IMAGE,
    })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
  );

  // -- the refusals, all identical
  // Naming no note at all no longer reaches the tool: `note` is required by
  // `read_image`'s advertised schema, and `src/toolArguments.js` now holds
  // callers to it. That is a refusal about the caller's own request, so it is
  // deliberately NOT in the byte-identity set below — it discloses nothing about
  // what exists, because nothing was looked up to answer it.
  const bareHash = await call("priv-token", "read_image", { image: `.context/assets/images/${TEAM_IMAGE}` });
  check(
    "an image cannot be resolved without naming a note",
    bareHash.isError === true && refusalText(bareHash).includes('missing required argument "note"')
  );
  // The property that check was really about — the `note` argument is the image
  // store's only authorization — still has to be proven at the handler, so here
  // is the version of it the schema lets through: a note named as the empty
  // string is a string, and reaches `toolReadImage`.
  const emptyNote = await call("priv-token", "read_image", {
    note: "",
    image: `.context/assets/images/${TEAM_IMAGE}`,
  });
  check(
    "...and naming an empty one, which the schema does allow through, resolves nothing",
    refusalText(emptyNote) === REFUSAL
  );
  const unreferenced = await call("priv-token", "read_image", {
    note: "1-projects/portable/no-image.md",
    image: `.context/assets/images/${TEAM_IMAGE}`,
  });
  check(
    "a note that does not reference the image resolves nothing",
    refusalText(unreferenced) === REFUSAL
  );
  const orphan = await call("priv-token", "read_image", {
    note: "1-projects/portable/with-image.md",
    image: `.context/assets/images/${ORPHAN_IMAGE}`,
  });
  check("an image no named note references resolves nothing", refusalText(orphan) === REFUSAL);

  // The `.md` half of the note check, which nothing held: dropping
  // `.endsWith(".md")` from `toolReadImage` passed the entire suite.
  //
  // It is not redundant with `canSee`. At private scope `canSee` returns true for
  // *any* non-plumbing key, and at team scope it asks the folder's visibility —
  // neither asks whether the key is a note. So without it `read_image` accepts a
  // non-markdown object as the "note", reads it, and answers on whether its bytes
  // contain the leaf.
  //
  // **What that is worth. Two reviews, and the second measured what the first two
  // versions of this comment only asserted.** Version one called it "a one-bit
  // oracle over files no note tool will open", on the strength of `read_note`
  // refusing a `.csv` — it does not, `toolReadNote` is `normalizePath` + `canSee`
  // with no `.md` gate. Version two corrected that into "a strict subset of what
  // `read_note` already grants — one bit about something wholly readable", which
  // is wrong in the other direction and by more.
  //
  // What the mutated tool returns is the **image's bytes**, at private and team
  // scope alike, and nothing else in the gateway can return them. The image lives
  // under `.context/assets/images/`, a dot-prefixed segment, so `isPlumbing` refuses it and
  // `read_note` of that key answers `not found` at every scope. The `note`
  // argument is the *only* authorization the image store has — the neighbouring
  // check above says so in its own words, an image no named note references
  // resolves nothing — and the `.md` gate is what stops any object the caller can
  // see from being that note. The chain needs no prior knowledge of the hash:
  // read the `.csv` (ungated, as above), take the leaf out of its text, pass the
  // `.csv` as the note.
  //
  // It is not `#116` that made this reachable, which version two also claimed.
  // `writeImage` writes only under `.context/assets/images/`, and a plumbing key can never be
  // the `note` argument. A non-`.md` object on the *note* surface arrives the way
  // the repo already documents keys arriving — Obsidian's sync, rclone, the
  // provider's own console — none of which pass through our path validation.
  //
  // The object below is seeded to *contain* the leaf, so the reference check
  // cannot be what refuses it and only the `.md` check can.
  await contextStore.put(
    "1-projects/portable/notes.csv",
    `filename,key\nshot.png,.context/assets/images/${TEAM_IMAGE}\n`
  );
  const nonMarkdownNote = await call("priv-token", "read_image", {
    note: "1-projects/portable/notes.csv",
    image: `.context/assets/images/${TEAM_IMAGE}`,
  });
  check(
    "a non-markdown object cannot stand in for the note, even holding the leaf",
    refusalText(nonMarkdownNote) === REFUSAL
  );
  const teamReachingIntoPrivate = await call("team-token", "read_image", {
    note: "1-projects/secret-thing/with-image.md",
    image: `.context/assets/images/${PRIVATE_IMAGE}`,
  });
  check(
    "a note the caller cannot see resolves nothing",
    refusalText(teamReachingIntoPrivate) === REFUSAL
  );

  /**
   * **The exact-note override, which every other fixture here is uniform against.**
   *
   * `teamReachingIntoPrivate` above is private by its FOLDER — `secret-thing` is
   * a `folder_defaults` entry — and so is every other private note in this
   * suite's manifest, whose `note_overrides` block is seeded empty. That
   * uniformity is the axis `toolReadImage`'s single `canSee(notePath, …)` was
   * unpinned along, and it was found by measurement rather than by reading:
   * replacing that call with a probe of the note's FOLDER left every check in
   * this file passing.
   *
   * It would not be an idle refactor to make. `visibleIndex` in
   * `src/search/query.js` calls `canSee` "the expensive thing in this function",
   * which is an invitation to cache it per folder — and
   * `effectiveVisibility(key, rules, overrides)` is
   * `overrides?.get(key) || visibilityOf(key, rules)`, keyed on the note's OWN
   * path. A folder probe therefore never sees an override, and a team connection
   * would read every image referenced by a note its owner had deliberately made
   * private inside a shared folder — the exception mechanism, which is the whole
   * point of having one.
   *
   * The note below lives in `1-projects/portable`, a team folder, and is narrowed
   * by `set_visibility` rather than by the manifest. The team read BEFORE the
   * narrowing is the positive control: without it a note that was never readable
   * would satisfy the assertion after.
   */
  const OVERRIDE_IMAGE = `${"9".repeat(64)}.png`;
  await contextStore.put(`.context/assets/images/${OVERRIDE_IMAGE}`, PNG_BYTES);
  const overridePath = "1-projects/portable/override-image.md";
  await contextStore.put(
    overridePath,
    `# team note, for now\n\n![a screenshot](.context/assets/images/${OVERRIDE_IMAGE})\n`
  );
  check(
    "the positive control: a team folder's note resolves its image for a team caller",
    (await call("team-token", "read_image", {
      note: overridePath,
      image: `.context/assets/images/${OVERRIDE_IMAGE}`,
    })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
  );
  const overrideEtag = (await call("priv-token", "read_note", { path: overridePath }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  const narrowedByOverride = await call("priv-token", "set_visibility", {
    path: overridePath,
    visibility: "private",
    expected_etag: overrideEtag,
  });
  check(
    "the narrowing itself succeeded, so the assertion below is about visibility",
    !narrowedByOverride.isError &&
      (await call("team-token", "read_note", { path: overridePath }))?.isError === true
  );
  const teamReachingIntoOverride = await call("team-token", "read_image", {
    note: overridePath,
    image: `.context/assets/images/${OVERRIDE_IMAGE}`,
  });
  check(
    "a note made private by exact-note override resolves no image for a team caller",
    refusalText(teamReachingIntoOverride) === REFUSAL
  );
  /**
   * **The same override, re-cased — because one shipped backend folds case.**
   *
   * Every privacy decision in this gateway is keyed on an exact path string.
   * `effectiveVisibility` is `overrides?.get(key) || visibilityOf(key, rules)`,
   * an exact `Map.get`; `isPlumbing` opens with `key === PRIVACY_KEY`. Both are
   * sound on a keyspace where one string is one object, which is what R2 and S3
   * are — and `DropboxStore` is not. Its own header says so, in the list of
   * things that make Dropbox not a keyspace:
   *
   *   > **Case-insensitive, Unicode-folding paths.** Dropbox treats `Foo.md` and
   *   > `foo.md` as the same file and normalises Unicode. Nothing here tries to
   *   > paper over that: the keys this product writes are already normalised …
   *
   * The keys *this product* writes are. The keys a **caller** supplies are not,
   * and `write_note`, `read_note`, `move_note` and `propose_note` all take a
   * path straight from the connected AI client. So on a Dropbox-backed context
   * two different strings name one file while the privacy engine scores them as
   * two different notes, and the score that matters is the one the attacker
   * picks:
   *
   *  - `Privacy.md` is not `privacy.md`, so `isPlumbing` does not reserve it —
   *    and Dropbox writes it to the manifest anyway. That is `write_note`
   *    rewriting the file that decides what every team connection may read,
   *    through the one path the tool answers "that path is reserved" for.
   *  - `1-projects/portable/Override-Image.md` misses the override Map, but the
   *    FOLDER rule `1-projects: team` still matches — folder matching is a
   *    prefix compare that the re-casing above leaves untouched. So the note
   *    scores `team`, and Dropbox hands back the private file.
   *
   * The direction is what makes this a hole rather than a wobble. Re-casing a
   * *folder* makes every rule miss and `visibilityOf` falls back to `private`,
   * which fails closed. Re-casing a *note* leaves the folder rule matching and
   * drops only the narrowing override, which fails open — the exception
   * mechanism, again, and the same one the fixture above exists for.
   *
   * These assertions are about the DECISION, not about Dropbox: this suite's
   * store stub is case-sensitive, so the twin below is a genuinely different
   * object here and refusing it is the fail-closed cost of the fix rather than
   * the vulnerability itself. That cost is the point. A privacy answer that
   * depends on which backend is underneath is an answer nobody can check, so the
   * engine gives the restrictive one everywhere and the adapter is left alone —
   * which is also what `DropboxStore` asks for when it says a store that
   * silently re-cased a caller's key would be worse than one that does not.
   */
  const recasedManifest = await call("priv-token", "write_note", {
    path: "Privacy.md",
    content: "default_visibility: team\n",
  });
  check(
    "the privacy manifest is reserved under any casing",
    recasedManifest.isError === true && /reserved/.test(recasedManifest.content?.[0]?.text ?? "")
  );

  const recasedOverridePath = "1-projects/portable/Override-Image.md";
  const recasedOverrideWrite = await call("team-token", "write_note", {
    path: recasedOverridePath,
    content: "# written past an override\n",
  });
  check(
    // Matched on the text, not merely on isError: "some error" is one refactor
    // away from passing because the path stopped existing.
    "a team caller cannot write past an exact-note override by re-casing it",
    recasedOverrideWrite.isError === true &&
      /permission denied: write destination/.test(recasedOverrideWrite.content?.[0]?.text ?? "")
  );

  await contextStore.put(recasedOverridePath, "# the same file, on a folding backend\n");
  const recasedOverrideRead = await call("team-token", "read_note", {
    path: recasedOverridePath,
  });
  check(
    "a team caller cannot read past an exact-note override by re-casing it",
    recasedOverrideRead.isError === true &&
      (recasedOverrideRead.content?.[0]?.text ?? "") === "not found"
  );

  check(
    "and the note it could not publish is still refused to a team caller",
    (await call("team-token", "read_note", { path: recasedOverridePath }))?.isError === true
  );

  /**
   * **The tool nobody had counted.**
   *
   * Three reviews and four commits enumerated the tools that change a visibility
   * and left this one out every time. It is also the only one that fails OPEN
   * rather than closed, which is why its guard is the one piece of that work
   * kept here: without it the fold is a regression rather than a fix.
   *
   * Its compaction loop drops an override that has become redundant *for its own
   * exact path* — correct before the fold, and wrong after it, because the same
   * line is what narrows every path that folds onto it. The impact report walks
   * only `${folder}/`, so a twin living in a differently-cased sibling folder is
   * never scanned: `newly_team_visible_notes` says 0, no publication confirmation
   * is required, and a note the owner had marked private becomes team-readable
   * with nothing said. That is content, not existence — the severe direction.
   *
   * The fold created the coupling, so the fix belongs here: a `private` override
   * is never compacted away, because this loop cannot see who else is relying on
   * it. A redundant private line costs a line of manifest.
   */
  const foldFolderA = "fold-folder";
  const foldFolderB = "Fold-Folder";
  await contextStore.put(`${foldFolderA}/note.md`, "# the note that must stay private\n");
  await contextStore.put(`${foldFolderB}/Note.md`, "# its twin, in a folder that folds\n");
  // `set_folder_visibility` refuses an apply with no `expected_privacy_etag`, and
  // that refusal looks like any other — the first version of this fixture never
  // applied at all, so the scenario it describes never existed. Drive it the way
  // a real client does: dry run, take the etag, apply.
  const setFolder = async (path, visibility) => {
    const preview = await call("priv-token", "set_folder_visibility", {
      path,
      visibility,
      dry_run: true,
    });
    const privacyEtag = preview?.content?.[0]?.text?.match(/privacy_etag: (\S+)/)?.[1];
    return call("priv-token", "set_folder_visibility", {
      path,
      visibility,
      expected_privacy_etag: privacyEtag,
      confirm_team_publish: true,
    });
  };
  const sharedA = await setFolder(foldFolderA, "team");
  const sharedB = await setFolder(foldFolderB, "team");
  check(
    "the fixture applied: both folders really are team before the narrowing",
    sharedA?.isError !== true &&
      sharedB?.isError !== true &&
      (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError !== true
  );
  const foldNoteEtag = (await call("priv-token", "read_note", { path: `${foldFolderA}/note.md` }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  await call("priv-token", "set_visibility", {
    path: `${foldFolderA}/note.md`,
    visibility: "private",
    expected_etag: foldNoteEtag,
  });
  check(
    "the positive control: the twin is private by fold before the folder changes",
    (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError === true
  );
  // Narrowing the FIRST folder makes its own override redundant. Compacting it
  // away would publish the twin in the second folder.
  const narrowed = await setFolder(foldFolderA, "private");
  /**
   * **And the same publish through the most ordinary call there is.**
   *
   * The first guard written for this reasoned over folder rules: a twin is only
   * widened, it said, by a `team` rule governing the folded path but not the
   * exact one — a case-variant folder rule, enumerable in the manifest. That is
   * false, and the counter-example needs no hand-edited manifest at all.
   * `visibilityOf` is longest-prefix; the guard was any-prefix. A single `team`
   * rule governing BOTH the note and its twin, out-ranked for the note by the
   * longer `private` rule *this very call adds*, widens the twin and the guard
   * cannot see it — reached by "make this folder private", which is the last call
   * an owner would audit.
   *
   * So no `private` override is compacted away, full stop. This loop cannot see
   * who is relying on one, and a redundant line costs a line of manifest. The
   * rule-shaped version of this was written, shipped, and found wrong within the
   * hour; reasoning about who a narrowing protects means simulating the write,
   * and a weaker copy of that reasoning is worth less than a redundant line of
   * manifest.
   */
  const quietA = "1-projects/quiet/x.md";
  const quietTwin = "1-projects/Quiet/x.md";
  await contextStore.put(quietA, "# the private one\n");
  await contextStore.put(quietTwin, "# a different file that folds onto it\n");
  const quietEtag = (await call("priv-token", "read_note", { path: quietA }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  await call("priv-token", "set_visibility", {
    path: quietA,
    visibility: "private",
    expected_etag: quietEtag,
  });
  check(
    "the positive control: the twin is private by fold, under one plain team rule",
    (await call("team-token", "read_note", { path: quietTwin }))?.isError === true
  );
  const quietNarrow = await setFolder("1-projects/quiet", "private");
  check(
    "narrowing a folder does not publish a twin governed by the same team rule",
    quietNarrow?.isError !== true &&
      (await call("team-token", "read_note", { path: quietTwin }))?.isError === true
  );
  // Folder rule first, then the override — clearing an override means setting it
  // to what the note now INHERITS, so doing it in the other order writes a fresh
  // override instead of removing one.
  await setFolder("1-projects/quiet", "inherit");
  await call("priv-token", "set_visibility", {
    path: quietA,
    visibility: "team",
    confirm_team_publish: true,
  });
  await contextStore.delete(quietA);
  await contextStore.delete(quietTwin);

  check(
    "narrowing one folder does not publish a note that folds onto it in another",
    narrowed?.isError !== true &&
      (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError === true
  );
  /**
   * **The exact delete, which this change made reachable.**
   *
   * `persistExactVisibility` and `clearExactVisibility` delete an override by its
   * exact path — a fold reads across case, it never writes across it. That used
   * to be documented as unreachable defence-in-depth, because six tools refused a
   * folded twin before either could be called, and CLAUDE.md said so: "sabotaging
   * either passes the whole gateway suite". Those refusals came out with the
   * write-path apparatus, and the residual bullet came out with them — so the
   * exact delete is now the only thing standing between `set_visibility` on
   * `Notes.md` and `notes.md` losing the narrowing its owner wrote. Consent taken
   * for one file and spent on another, and it fails OPEN.
   *
   * Both directions are here because they are separate functions: the persist
   * path (a visibility change that lands on the delete branch) and the clear path
   * (the source of a move).
   */
  const exactDeleteKeep = "1-projects/portable/keep-narrowing.md";
  const exactDeleteTwin = "1-projects/portable/Keep-Narrowing.md";
  await contextStore.put(exactDeleteKeep, "# the narrowed original\n");
  await contextStore.put(exactDeleteTwin, "# a different file that folds onto it\n");
  const keepEtag = (await call("priv-token", "read_note", { path: exactDeleteKeep }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  await call("priv-token", "set_visibility", {
    path: exactDeleteKeep,
    visibility: "private",
    expected_etag: keepEtag,
  });
  check(
    "the positive control: the original is narrowed and its twin reads private too",
    (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true &&
      (await call("team-token", "read_note", { path: exactDeleteTwin }))?.isError === true
  );
  // persistExactVisibility's delete branch: `Keep-Narrowing.md` inherits team, so
  // asking for team takes the delete. It must remove nothing.
  await call("priv-token", "set_visibility", {
    path: exactDeleteTwin,
    visibility: "team",
    confirm_team_publish: true,
  });
  check(
    "changing a case-variant's visibility does not clear the original's narrowing",
    (await (await contextStore.get("privacy.md")).text()).includes(`${exactDeleteKeep}: private`) &&
      (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true
  );
  // clearExactVisibility, through the source of a move.
  const keepMoveEtag = (await call("priv-token", "read_note", { path: exactDeleteTwin }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  await call("priv-token", "move_note", {
    source: exactDeleteTwin,
    destination: "1-projects/portable/keep-moved.md",
    expected_source_etag: keepMoveEtag,
  });
  check(
    "moving a case-variant away does not clear the original's narrowing either",
    (await (await contextStore.get("privacy.md")).text()).includes(`${exactDeleteKeep}: private`) &&
      (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true
  );
  // Clear the override against what the note inherits, then drop the objects.
  await call("priv-token", "set_visibility", {
    path: exactDeleteKeep,
    visibility: "team",
    confirm_team_publish: true,
  });
  // The move wrote a `private` override at its destination — the folded read is
  // what `move_note` persists — so the object is not the only thing to clean up.
  // The block's own comment above says exactly this, and this block did it wrong.
  await call("priv-token", "set_visibility", {
    path: "1-projects/portable/keep-moved.md",
    visibility: "team",
    confirm_team_publish: true,
  });
  await contextStore.delete(exactDeleteKeep);
  await contextStore.delete("1-projects/portable/keep-moved.md");

  /**
   * **The fold's direction, checked in the gateway's own suite.**
   *
   * `overrideFor` folding a `team` override as well as a `private` one is the
   * hole this whole change had in its first version, and it was caught only by
   * `apps/convex/__tests__/privacyEngine.test.ts` — the gateway suite passed with
   * the widening in place. CLAUDE.md calls this suite the fast, offline one a
   * self-hoster runs, and self-hosting is a published commitment: somebody
   * running only `pnpm test` here must be able to see a widening fold in the
   * engine they deploy.
   *
   * It was deleted as collateral when the write-path refusals came out, which it
   * had nothing to do with — it pins the narrowing rule, not a refusal.
   *
   * `2-areas/private` is a private folder. Publishing one note by exact override
   * must not publish its case-variant, which on R2 and S3 is a different file the
   * owner never named.
   */
  const widenFoldPath = "2-areas/private/fold-widen.md";
  const widenFoldTwin = "2-areas/private/Fold-Widen.md";
  await contextStore.put(widenFoldPath, "# deliberately published\n");
  await contextStore.put(widenFoldTwin, "# a different file, never named\n");
  const widenFoldEtag = (await call("priv-token", "read_note", { path: widenFoldPath }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  const widenFoldPublish = await call("priv-token", "set_visibility", {
    path: widenFoldPath,
    visibility: "team",
    expected_etag: widenFoldEtag,
    confirm_team_publish: true,
  });
  check(
    "the positive control: the note the owner named IS readable by a team caller",
    widenFoldPublish?.isError !== true &&
      (await call("team-token", "read_note", { path: widenFoldPath }))?.isError !== true
  );
  check(
    "a team override does not travel by re-casing, in the gateway's own suite",
    (await call("team-token", "read_note", { path: widenFoldTwin }))?.isError === true
  );
  await call("priv-token", "set_visibility", { path: widenFoldPath, visibility: "private" });
  await contextStore.delete(widenFoldPath);
  await contextStore.delete(widenFoldTwin);

  // Put the manifest back too, not just the objects. The first version of this
  // block deleted the two notes and left `fold-folder: private`,
  // `Fold-Folder: team` and the note override standing in the shared bucket for
  // every check after it — eight lines below its own comment saying to clear the
  // override before the object.
  // An override is cleared by setting the note to what it INHERITS — and
  // `set_visibility` short-circuits when the value already matches, so asking for
  // `private` while the note already reads private removes nothing. Put the
  // folder back to `team` for one call, clear the override against it, then drop
  // the rule.
  await setFolder(foldFolderB, "inherit");
  await setFolder(foldFolderA, "team");
  await call("priv-token", "set_visibility", {
    path: `${foldFolderA}/note.md`,
    visibility: "team",
    confirm_team_publish: true,
  });
  await setFolder(foldFolderA, "inherit");
  for (const key of [`${foldFolderA}/note.md`, `${foldFolderB}/Note.md`]) {
    await contextStore.delete(key);
  }
  await contextStore.delete(recasedOverridePath);

  /**
   * **And the other direction, because the fixture above only narrows.**
   *
   * A folder probe that honoured a *narrowing* override and ignored a *widening*
   * one would pass every check to this point — measured, 805 of 805. The axis
   * this file's own new fixture holds constant is the override's direction, and
   * the law it was written to demonstrate applies to it as much as to anything
   * else.
   *
   * `2-areas/private/meetings/inherited-private.md` is already published to
   * `team` by exact override inside a private folder, further up this file, so
   * the case costs an image and a read rather than a new scenario. It fails
   * closed rather than open — a probe that missed it would refuse a read the
   * owner deliberately published — which is why it is a second check here and not
   * the first.
   */
  const WIDENED_IMAGE = `${"8".repeat(64)}.png`;
  await contextStore.put(`.context/assets/images/${WIDENED_IMAGE}`, PNG_BYTES);
  const widenedPath = "2-areas/private/meetings/widened-image.md";
  await contextStore.put(
    widenedPath,
    `# published inside a private folder\n\n![a screenshot](.context/assets/images/${WIDENED_IMAGE})\n`
  );
  const widenedEtag = (await call("priv-token", "read_note", { path: widenedPath }))
    ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  const widenedByOverride = await call("priv-token", "set_visibility", {
    path: widenedPath,
    visibility: "team",
    expected_etag: widenedEtag,
    confirm_team_publish: true,
  });
  check(
    "the widening itself succeeded, so the assertion below is about visibility",
    !widenedByOverride.isError &&
      !(await call("team-token", "read_note", { path: widenedPath }))?.isError
  );
  check(
    "a note published by exact-note override inside a private folder resolves its image",
    (await call("team-token", "read_image", {
      note: widenedPath,
      image: `.context/assets/images/${WIDENED_IMAGE}`,
    })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
  );
  const missingNote = await call("priv-token", "read_image", {
    note: "1-projects/portable/does-not-exist.md",
    image: `.context/assets/images/${TEAM_IMAGE}`,
  });
  check("a note that does not exist resolves nothing", refusalText(missingNote) === REFUSAL);
  const missingImage = await call("priv-token", "read_image", {
    note: "1-projects/portable/with-image.md",
    image: `.context/assets/images/${"f".repeat(64)}.png`,
  });
  check("an image that does not exist resolves nothing", refusalText(missingImage) === REFUSAL);
  check(
    "every image refusal is byte-identical, so nothing can be distinguished",
    new Set([
      refusalText(emptyNote),
      refusalText(unreferenced),
      refusalText(orphan),
      refusalText(teamReachingIntoPrivate),
      refusalText(teamReachingIntoOverride),
      refusalText(missingNote),
      refusalText(missingImage),
    ]).size === 1
  );


}
