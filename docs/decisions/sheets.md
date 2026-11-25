# Sheets

A sheet is a table kept in a workspace as a plain `.csv` file, opened in the
app as a grid and read and changed by agents through `fetch` and `write`.
Decided with the owner, 2026-11-23, starting from where an area's metrics
live: in a sheet in the workspace, not in a backend database.

## One `.csv` file per sheet, types in the header

Each column's type rides in its header cell after the last colon:
`date:date,metric:select,value:number,source,by:person`. The types are
`text`, `number`, `usd`, `date` (YYYY-MM-DD), `person`, `select`, `checkbox`
and `link`. A header with no known type after its last colon is text, and its
whole cell is the name, so `starts: 10:30` stays a text column with that name.
A select column's options are the distinct values already in it.

The file is the whole truth: no sidecar, no YAML, no database beside it. The
owner turned a sidecar down ("a YAML and a CSV, that feels like a lot"). Any
spreadsheet opens the file, and a typed header reads as a column name there.

The extension stays `.csv`, not `.csv.md`: every tool that opens a CSV knows
it, and the Markdown readers would mangle it.

What a simplification would cost: types kept anywhere but the header means two
files that drift, and an export that is not the whole sheet.
`apps/mcp/test/sheets.test.mjs` fails if the header split moves to the first
colon.

## Nothing a reader does drops a cell

A ragged row is kept and reported with its line, never cut. A sheet over 50,000
rows or 5 MB is held back whole and named, never read in part. Changing a
column's type keeps every value and counts the ones that don't fit; the grid
marks them. `sheets.test.mjs` covers each.

## A sheet saves like a note

A `.csv` goes through the same `write_note` save as a note
(`apps/mcp/src/tools/notes/write.js`), after checking it reads back whole: who
may write there, the folder's tier, the etag and the audit line are the note's
checks, not a second copy of them. Row changes (`write` action `rows`,
`sheetRows.js`) rebuild the text and save it the same way. A change that does
not fit the types is refused whole and nothing is written, and an update or
delete needs a non-empty match, so no call empties a sheet by accident. Two
agents appending at once both land: a lost append is read again and retried
once; an update or delete never retries.

`apps/mcp/test/sheetsGateway.test.mjs` fails if the row path saves around
`toolWriteNote` or skips `canSee`.

## Who sees a sheet is set like a note

A sheet takes its folder's visibility, and can carry its own, private or team
or named people, exactly as a note does (the exact-override parser, the
`set_visibility` tool and Convex's `takesOwnVisibility` accept `.csv`). Share
in the app is the note's Share. A hidden sheet and a missing one get the same
"not found" through `fetch` (`readSheet.js`) and through `write` rows.

## Reading through fetch

`fetch` on a `.csv` path returns its rows as a Markdown table with each row's
file line, filtered (`where`), sorted (`sort`), trimmed (`last`, `limit`) and
narrowed (`columns`), marked untrusted like a file's words: whoever wrote the
cells wrote a quotation, never an instruction.

## What is deliberately not built

No chart tab, no source tab, no formulas, no per-sheet views saved in the
file, and no metric-specific UI: the grid is generic and works in any folder.
Formulas over sheets live in metric notes, not in cells
([data-and-metrics](./data-and-metrics.md), 2026-11-24).
Search does not index a sheet's cells yet, and `manage` move takes notes only,
so an agent cannot move a sheet yet; both are follow-ups, not decisions.
