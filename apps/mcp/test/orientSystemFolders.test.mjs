// orient's "System folders" lines (`src/orient/systemFolders.js`): every folder
// Context treats specially, its job, whether it is required, and the path it
// has now, wherever the person nested it.
import test from "node:test";
import assert from "node:assert/strict";
import { systemFoldersSection } from "../src/orient/systemFolders.js";

const jobs = (overrides) => ({
  inbox: null, projects: null, areas: null, resources: null, archive: null,
  clients: null, teams: null, products: null, website: null, meetings: null, tex: null,
  ...overrides,
});

test("a nested folder is named at the path the tree gives, not its default name", () => {
  const text = systemFoldersSection({
    folders: [{ prefix: "Work/" }],
    jobs: jobs({ inbox: "Capture", projects: "Work/Projects", areas: "Work/Areas", resources: "Library", archive: "4-archive", meetings: "Capture/calls" }),
  });
  assert.match(text, /^- Projects `Work\/Projects\/` — needed: active work/m);
  assert.match(text, /^- Inbox `Capture\/` — needed: .*Its own folders Calendar, Contacts, Email, Forms, Google Chat, iMessage, Meetings, Memories, Sessions stay where they are/m);
  assert.match(text, /^- Meetings `Capture\/calls\/` — made when used: /m);
  assert.doesNotMatch(text, /1-projects/);
  assert.doesNotMatch(text, /not found/);
  // Archive last, after the optional ones.
  const order = [...text.matchAll(/^- (\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(order, ["Inbox", "Projects", "Areas", "Resources", "Meetings", "Archive"]);
});

test("each line says needed, made when used, or optional", () => {
  const text = systemFoldersSection({ folders: [], jobs: jobs({ inbox: "0-inbox", clients: "4-clients", website: "website" }) });
  assert.match(text, /^- Inbox `0-inbox\/` — needed: /m);
  assert.match(text, /^- Clients `4-clients\/` — optional: /m);
  assert.match(text, /^- Website `website\/` — made when used: /m);
});

test("a required folder this connection cannot find is said as not found, never as absent", () => {
  const text = systemFoldersSection({ folders: [], jobs: jobs({ website: "website" }) });
  assert.match(text, /Needed but not found by this connection: Inbox, Projects, Areas, Resources, Archive\./);
  assert.match(text, /`manage` action `folder_job`/);
  // Optional ones nobody set up are not listed as missing.
  assert.doesNotMatch(text, /Clients|Teams|Products|Meetings/);
});

test("without the tree's answer, top-level folder names decide", () => {
  const text = systemFoldersSection({
    folders: [{ prefix: "0-inbox/" }, { prefix: "1-projects/" }, { prefix: "2-areas/" }, { prefix: "3-resources/" }, { prefix: "9-archive/" }, { prefix: "notes/" }],
  });
  assert.match(text, /^- Projects `1-projects\/` — needed/m);
  assert.match(text, /^- Archive `9-archive\/` — needed/m);
  assert.doesNotMatch(text, /notes\//);
  assert.doesNotMatch(text, /not found/);
});

test("Tex's folder is listed wherever it is nested, and meetings in the Inbox's own folder fold into the Inbox line", () => {
  const text = systemFoldersSection({
    folders: [],
    jobs: jobs({ inbox: "Capture", projects: "1-projects", areas: "Life", resources: "Library", archive: "Old", tex: "Life/Assistant", meetings: "Capture/meetings" }),
  });
  assert.match(text, /^- Tex `Life\/Assistant\/` — made when used: .*routines.*tex\/\.\.\. lands here/m);
  assert.doesNotMatch(text, /^- Meetings/m);
});

test("Tex's line names its own folders, which stay where they are (owner, 2026-10-21)", () => {
  const text = systemFoldersSection({ folders: [], jobs: jobs({ tex: "Assistant/tex" }) });
  assert.match(text, /^- Tex `Assistant\/tex\/` — made when used: .*Its own folders attention, dreams, heartbeat, housekeeping, routines, skills, transcripts stay where they are/m);
});
