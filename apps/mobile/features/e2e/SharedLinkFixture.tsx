import { useState } from "react";
import { SharedConsole } from "../share/SharedConsole";
import type { SharedNote } from "../share/share";

/**
 * A shared link's page on a fixed note, for screenshots and the WebKit job.
 * The same `SharedConsole` `/s/<token>` draws, given what `readSharedNote`
 * would have returned; following a link swaps in the next note.
 */
const NOTES: Record<string, string> = {
  "1-projects/grant/grant-writing-collab.md": [
    "# Grant Writing Collab",
    "",
    "## Summary",
    "",
    "The team will apply again for the worship grant, due **October 15**. Last year's application was declined, so this year frames the proposal as an ongoing worship learning program.",
    "",
    "The ask is still open at $20,000 or $25,000. [[2027-budget]] carries the working numbers.",
    "",
    "## Action items",
    "",
    "- [ ] Kayla Marie: revise last year's application around a year-long program.",
    "- [ ] Kenzie: draft the full 2027 budget by Monday, October 12.",
    "- [x] Shay: ask Pastor Mark and Pastor Mackin for reference letters.",
    "",
  ].join("\n"),
  "1-projects/grant/2027-budget.md": "# 2027 budget\n\n| Item | Amount |\n| --- | --- |\n| New York gatherings | $5,000 |\n| DMV launch | $10,000 |\n",
};

const LINKS = ["1-projects/grant/2027-budget.md", "3-resources/funder-rules.md"];

export function SharedLinkFixture({ anyone, folder = false }: { anyone: boolean; folder?: boolean }) {
  const [path, setPath] = useState(folder ? "1-projects/grant" : "1-projects/grant/grant-writing-collab.md");
  const note: SharedNote = path === "1-projects/grant" ? {
    path,
    text: null,
    kind: "folder",
    entries: [
      { path: "1-projects/grant/grant-writing-collab.md", name: "grant-writing-collab.md", kind: "file" },
      { path: "1-projects/grant/2027-budget.md", name: "2027-budget.md", kind: "file" },
    ],
    entryPath: path,
    links: [],
    openToAnyone: anyone,
    collecting: false,
    editableInContext: null,
  } : {
    path,
    text: NOTES[path] ?? "# Not in this fixture",
    kind: "note",
    entries: [],
    entryPath: "1-projects/grant/grant-writing-collab.md",
    links: path === "1-projects/grant/grant-writing-collab.md" ? LINKS : [],
    openToAnyone: anyone,
    collecting: false,
    editableInContext: null,
  };
  return <SharedConsole note={note} signedIn={false} onOpen={setPath} onSignIn={() => {}} />;
}
