/**
 * The gateway's row renderer (`src/privacy/rowAccess.js`) driven through the
 * engine's own `canSee`. The control plane's twin, and the proof that the two
 * agree, is `apps/convex/__tests__/nodes/rowAccessPort.test.ts`; these are the
 * answers the gateway must give on its own.
 *
 * Sabotage: make `accessNamesFor` hand a folder grant to descendant notes'
 * tokens (a list merging into its ancestor's) and "a note's list replaces its
 * folder's" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canSee } from "../../src/privacy/engine.js";
import { accessNamesFor, renderAccess, tokenFor } from "../../src/privacy/rowAccess.js";

const FOLDER_CLIENTS = "00000000-0000-7000-8000-000000000004";
const NOTE_ACME = "00000000-0000-7000-8000-000000000006";
const NOTE_BOB = "00000000-0000-7000-8000-000000000005";
const FOLDER_HR = "00000000-0000-7000-8000-000000000001";
const NOTE_TEAM = "00000000-0000-7000-8000-000000000003";

/** Render the rows for an audience and answer `canSee` for one caller. */
function reader(rows, audience, caller, scope = "team") {
  const { rules, overrides } = renderAccess(rows, audience);
  const granted = new Set(accessNamesFor(caller, rows));
  return (key) => canSee(key, scope, rules, overrides, granted);
}

const clientRows = () => [
  {
    path: "2-areas/clients",
    noteId: FOLDER_CLIENTS,
    kind: "folder",
    base: "private",
    grantees: [{ kind: "user", id: "user-kola", role: "view" }],
  },
  // A note with its own list. Its list replaces the folder's for this note.
  {
    path: "2-areas/clients/acme.md",
    noteId: NOTE_ACME,
    kind: "file",
    base: "private",
    grantees: [{ kind: "user", id: "user-ana", role: "view" }],
  },
];

test("a note's list replaces its folder's list: the folder grantee is denied the note", () => {
  const rows = clientRows();
  const kola = reader(rows, "member", { userId: "user-kola" });
  const ana = reader(rows, "member", { userId: "user-ana" });
  // Kola is on the folder list; the note's own list does not name her.
  assert.equal(kola("2-areas/clients/acme.md"), false);
  // The folder's other notes still follow the folder's list.
  assert.equal(kola("2-areas/clients/notes.md"), true);
  // Ana is on the note's list alone, and gets the note.
  assert.equal(ana("2-areas/clients/acme.md"), true);
  assert.equal(ana("2-areas/clients/notes.md"), false);
});

test("the folder's grant names the folder's token, and never a descendant note's token", () => {
  const names = accessNamesFor({ userId: "user-kola" }, clientRows());
  assert.deepEqual(names, [tokenFor(FOLDER_CLIENTS)]);
  assert.ok(!names.includes(tokenFor(NOTE_ACME)));
});

test("a guest sees only the listed subtree, never team material outside it", () => {
  const rows = [
    ...clientRows(),
    // Team to members, but a guest is never given `team`.
    { path: "2-areas/hr", noteId: FOLDER_HR, kind: "folder", base: "team", grantees: [] },
    { path: "2-areas/hr/policy.md", noteId: NOTE_TEAM, kind: "file", base: "team", grantees: [] },
    // A sibling of the listed folder whose name only starts with it.
    { path: "2-areas/clients-old", noteId: NOTE_BOB, kind: "folder", base: "team", grantees: [] },
  ];
  const guest = reader(rows, "guest", { userId: "user-kola" });
  assert.equal(guest("2-areas/clients/notes.md"), true);
  assert.equal(guest("2-areas/clients/acme.md"), false);
  assert.equal(guest("2-areas/hr/policy.md"), false);
  assert.equal(guest("2-areas/clients-old/x.md"), false);
  assert.equal(guest("1-projects/roadmap.md"), false);
});

test("a team folder's list is open to members with or without the list", () => {
  const rows = [
    {
      path: "1-projects",
      noteId: FOLDER_HR,
      kind: "folder",
      base: "team",
      grantees: [{ kind: "user", id: "user-kola", role: "view" }],
    },
  ];
  assert.equal(reader(rows, "member", {})("1-projects/roadmap.md"), true);
});

test("an edit grant adds its edit name beside the view name, and visibility still follows the view name", () => {
  const rows = [
    {
      path: "2-areas/deal.md",
      noteId: NOTE_ACME,
      kind: "file",
      base: "private",
      grantees: [{ kind: "user", id: "user-ana", role: "edit" }],
    },
  ];
  assert.deepEqual(accessNamesFor({ userId: "user-ana" }, rows), [tokenFor(NOTE_ACME), `${tokenFor(NOTE_ACME)}!edit`].sort());
  assert.equal(reader(rows, "guest", { userId: "user-ana" })("2-areas/deal.md"), true);
});

test("rendering refuses two rows for one path and a row on the root", () => {
  const dup = [
    { path: "2-areas/x.md", noteId: NOTE_ACME, kind: "file", base: "private", grantees: [] },
    { path: "2-areas/x.md", noteId: NOTE_BOB, kind: "file", base: "team", grantees: [] },
  ];
  assert.throws(() => renderAccess(dup, "member"), /two access rows for 2-areas\/x\.md/);
  const root = [{ path: "", noteId: NOTE_BOB, kind: "folder", base: "team", grantees: [] }];
  assert.throws(() => renderAccess(root, "member"), /root carries no access row/);
});
