/**
 * A FOLDER MOVE THAT A SYNC WRITES INTO MUST STILL FINISH.
 *
 * A logical folder move pins each source's etag when it starts. The contact
 * sync writes a contact page at its physical key, so a mail or chat message
 * arriving while `0-inbox/contacts/` is being moved changed a pinned source and
 * left the move paused for good ("source changed during materialization"):
 * every later write under the folder was refused as "being moved". Seen on a
 * real workspace on 2026-10-12.
 *
 * A page the sync renders (a contact page under the contacts folder,
 * `type: "contact"`) is the sync's to change, and the newest version is the
 * one the destination should hold. Anything else still refuses exactly as
 * before: a person's own note that changed under a move is a conflict.
 *
 * ## Sabotage record
 *
 *   copy stage never adopts a changed source                         1
 *   copy stage adopts any changed source, a person's note included   1
 *   cleanup never refreshes the destination                          1
 *   cleanup refreshes a destination somebody else changed            1
 */

import { check, contextStore, objects, storedText } from "./harness.mjs";
import { toolMaterializeMove } from "../src/tools/moves/materialize.js";

const contactPage = (name, extra = "") =>
  `---\nupdated: "2026-10-12T15:00:00.000Z"\ntype: "contact"\nslug: "${name}"\n---\n\n# ${name}\n\n## Identifiers\n\n- email: ${name}@example.com\n${extra}\n## Notes\n\n`;

async function job(id, source, destination, items, extra = {}) {
  await contextStore.put(`.context/moves/${id}.json`, JSON.stringify({
    version: 1,
    id,
    source,
    destination,
    status: "logical_active",
    objects: items,
    copied: [],
    copied_objects: 0,
    deleted: [],
    deleted_objects: 0,
    ...extra,
  }));
}

async function run(id) {
  let result;
  for (let pass = 0; pass < 6; pass += 1) {
    result = await toolMaterializeMove(contextStore, "private", id, 100);
    if (result.isError || result.content?.[0]?.text?.includes("complete")) break;
  }
  return result;
}

async function cleanup(id, paths) {
  await contextStore.delete(`.context/moves/${id}.json`);
  for (const path of paths) await contextStore.delete(path);
}

export async function checkSyncOwnedSourceChanges() {
  // 1. Changed before it was copied: the newest version is what moves.
  {
    const id = "move-sync-owned-copy";
    const source = "0-inbox/contacts/email-ada-example-com.md";
    const destination = "4-archive/moved-contacts/email-ada-example-com.md";
    const pinned = await contextStore.put(source, contactPage("ada"));
    await job(id, "0-inbox/contacts", "4-archive/moved-contacts", [
      { source, destination, etag: pinned.etag, size: 10 },
    ]);
    const newest = contactPage("ada", "- phone: +15551234567\n");
    await contextStore.put(source, newest);
    const result = await run(id);
    check(
      "A CONTACT PAGE THE SYNC CHANGED BEFORE IT WAS COPIED STILL MOVES, newest version and all",
      !result.isError && storedText(destination) === newest && !objects.has(source)
    );
    await cleanup(id, [source, destination]);
  }

  // 2. Changed after it was copied: the untouched copy is refreshed, then retired.
  {
    const id = "move-sync-owned-cleanup";
    const source = "0-inbox/contacts/email-bo-example-com.md";
    const destination = "4-archive/moved-contacts/email-bo-example-com.md";
    const first = contactPage("bo");
    const pinned = await contextStore.put(source, first);
    const copy = await contextStore.put(destination, first);
    await job(id, "0-inbox/contacts", "4-archive/moved-contacts",
      [{ source, destination, etag: pinned.etag, size: first.length, copied_etag: copy.etag }],
      { status: "deleting", copied: [source], copied_objects: 1 });
    const newest = contactPage("bo", "- phone: +15557654321\n");
    await contextStore.put(source, newest);
    const result = await run(id);
    check(
      "...and one changed after its copy refreshes that copy before the source is retired",
      !result.isError && storedText(destination) === newest && !objects.has(source)
    );
    await cleanup(id, [source, destination]);
  }

  // 3. Somebody else changed the copy: never overwritten.
  {
    const id = "move-sync-owned-edited-copy";
    const source = "0-inbox/contacts/email-cy-example-com.md";
    const destination = "4-archive/moved-contacts/email-cy-example-com.md";
    const first = contactPage("cy");
    const pinned = await contextStore.put(source, first);
    const copy = await contextStore.put(destination, first);
    await job(id, "0-inbox/contacts", "4-archive/moved-contacts",
      [{ source, destination, etag: pinned.etag, size: first.length, copied_etag: copy.etag }],
      { status: "deleting", copied: [source], copied_objects: 1 });
    const edited = contactPage("cy", "- phone: +15550000000\n");
    await contextStore.put(destination, edited);
    await contextStore.put(source, contactPage("cy", "- phone: +15551111111\n"));
    const result = await run(id);
    check(
      "...but a copy somebody else changed is never overwritten: the move refuses",
      result.isError && storedText(destination) === edited && objects.has(source)
    );
    await cleanup(id, [source, destination]);
  }

  // 3b. Copied before copies were recorded: the copy stays, the newest sits beside it.
  {
    const id = "move-sync-owned-unrecorded-copy";
    const source = "0-inbox/contacts/email-di-example-com.md";
    const destination = "4-archive/moved-contacts/email-di-example-com.md";
    const beside = "4-archive/moved-contacts/email-di-example-com.newer.md";
    const first = contactPage("di");
    const pinned = await contextStore.put(source, first);
    await contextStore.put(destination, first);
    await job(id, "0-inbox/contacts", "4-archive/moved-contacts",
      [{ source, destination, etag: pinned.etag, size: first.length }],
      { status: "deleting", copied: [source], copied_objects: 1 });
    const newest = contactPage("di", "- phone: +15552222222\n");
    await contextStore.put(source, newest);
    const result = await run(id);
    check(
      "...and one copied before copies were recorded keeps its copy and the newest version beside it",
      !result.isError && storedText(destination) === first && storedText(beside) === newest &&
        !objects.has(source)
    );
    await cleanup(id, [source, destination, beside]);
  }

  // 4. A person's own note that changed still refuses, exactly as before.
  {
    const id = "move-human-note-changed";
    const source = "0-inbox/contacts/my-thoughts.md";
    const destination = "4-archive/moved-contacts/my-thoughts.md";
    const pinned = await contextStore.put(source, "# My thoughts\n");
    await job(id, "0-inbox/contacts", "4-archive/moved-contacts", [
      { source, destination, etag: pinned.etag, size: 14 },
    ]);
    await contextStore.put(source, "# My thoughts, edited\n");
    const result = await run(id);
    check(
      "A PERSON'S OWN NOTE THAT CHANGED UNDER A MOVE STILL PAUSES IT, never silently adopted",
      result.isError && /source changed during materialization/.test(result.content?.[0]?.text ?? "") &&
        objects.has(source) && !objects.has(destination)
    );
    await cleanup(id, [source, destination]);
  }
}
