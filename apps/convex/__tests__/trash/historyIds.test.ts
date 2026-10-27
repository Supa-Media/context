/**
 * Emptying the trash erases each note's editing history by its note id too
 * (`lib/trash/erase.ts`, `historyIdsOf`), since a note's head is filed by id
 * (`packages/collaboration/src/address.js`) and its row is gone by then.
 * Sabotage: answer no ids and this fails; the package's erase case
 * (`noteHeads.mjs`) shows the id erases the head and the history.
 */
import { expect, test } from "vitest";
import { historyIdsOf } from "../../functions/lib/trash/erase";

test("each Markdown note key names the id its history is filed under, and other files name none", () => {
  expect(
    historyIdsOf(["notes/0190a000-0000-7000-8000-00000000000a.md", "files/0190a000-0000-7000-8000-00000000000b.pdf", "notes/../x.md"]),
  ).toEqual(["0190a000-0000-7000-8000-00000000000a"]);
});
