/**
 * Sheets through the gateway: a `.csv` saved like a note, and its rows changed
 * with `write` action `rows` (`src/tools/notes/sheetRows.js`). Every check a
 * note's save makes holds for a sheet, because a sheet is saved through the
 * same `toolWriteNote`; these checks prove the three that matter most.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. The parse check in `write.js` removed: "a CSV that does not read back is refused" fails.
 * 2. `readSheet` in `sheetRows.js` skipping `canSee`: "and is told the same as for a sheet
 *    that does not exist" fails (the save refuses, but in other words). With that and
 *    `toolWriteNote` replaced by a raw put, "a team connection cannot add rows to a
 *    private sheet" fails too (the row lands): each layer holds on its own.
 * 3. The `.csv` branch in `privacy/engine.js` removed: every check that saves a sheet with a visibility fails.
 */

import { call, check, lacks, storedText, succeeded } from "./harness.mjs";

const text = (result) => result?.content?.map((part) => part.text).join("") ?? "";

export async function runSheetGatewayChecks() {
  const path = "1-projects/finance/metrics.csv";
  const created = await call("priv-token", "write", {
    path,
    content: "date:date,metric:select,value:number,source,by:person\n2026-11-16,Monthly cost,507,routine,Tex\n",
    args: { visibility: "team", confirm_team_publish: true },
  });
  check("a sheet is saved like a note", succeeded(created) && (await storedText(path))?.startsWith("date:date,"));

  // The privacy parsers take an exact override for `.csv` as written; a `.CSV` override line would make the whole
  // manifest unreadable, so the gate refuses it (`docs/decisions/file-kinds.md`).
  const shouting = await call("priv-token", "set_visibility", { path: "1-projects/finance/Budget.CSV", visibility: "private" });
  check("a .CSV takes its folder's visibility, never an override of its own", shouting?.isError === true && text(shouting).includes("invalid path"));

  const broken = await call("priv-token", "write", { path: "1-projects/finance/broken.csv", content: "a,b\n1\n" });
  check(
    "a CSV that does not read back is refused, naming the line",
    broken?.isError === true && text(broken).includes("line 2") && (await storedText("1-projects/finance/broken.csv")) == null,
  );

  const appended = await call("priv-token", "write", {
    action: "rows",
    path,
    args: { append: [{ date: "2026-11-23", metric: "Monthly cost", value: "$512", by: "Tex" }] },
  });
  check(
    "rows are appended, values kept as their type writes them",
    succeeded(appended) && text(appended).includes("appended 1") && (await storedText(path))?.endsWith("2026-11-23,Monthly cost,512,,Tex\n"),
  );

  const wrongType = await call("priv-token", "write", { action: "rows", path, args: { append: [{ date: "next week", value: "lots" }] } });
  check(
    "a row that does not fit the types is refused and nothing is written",
    wrongType?.isError === true && text(wrongType).includes("not a date") && lacks(await storedText(path), "next week"),
  );

  const updated = await call("priv-token", "write", {
    action: "rows",
    path,
    args: { update: { match: { date: "2026-11-23" }, set: { value: 515 } } },
  });
  check("matching rows are updated", succeeded(updated) && text(updated).includes("updated 1") && (await storedText(path))?.includes(",515,"));

  const everyRow = await call("priv-token", "write", { action: "rows", path, args: { delete: { match: {} } } });
  check("a delete must match something, never every row by accident", everyRow?.isError === true && (await storedText(path))?.includes("2026-11-16"));

  const privatePath = "1-projects/finance/payroll.csv";
  const kept = await call("priv-token", "write", { path: privatePath, content: "name,amount:usd\nAda,100\n", args: { visibility: "private" } });
  check("a sheet can be kept private on its own", succeeded(kept));
  const teamAppend = await call("team-token", "write", { action: "rows", path: privatePath, args: { append: [{ name: "Mallory", amount: 1 }] } });
  check(
    "a team connection cannot add rows to a private sheet",
    teamAppend?.isError === true && lacks(await storedText(privatePath), "Mallory"),
  );
  const missing = await call("team-token", "write", { action: "rows", path: "1-projects/finance/nothing.csv", args: { append: [{ name: "x" }] } });
  check(
    "and is told the same as for a sheet that does not exist",
    teamAppend?.isError === true && missing?.isError === true && text(teamAppend) === text(missing),
  );

  // Browsing a folder names its sheets: an agent is never left to guess that one exists (`docs/decisions/file-kinds.md`).
  const listed = await call("priv-token", "fetch", { id: "1-projects/finance/" });
  check("fetch on a folder lists its sheets beside its notes", succeeded(listed) && text(listed).includes("1-projects/finance/metrics.csv"));
  const teamListed = await call("team-token", "fetch", { id: "1-projects/finance/" });
  check(
    "and a team connection is not told a private sheet's name",
    succeeded(teamListed) && text(teamListed).includes("metrics.csv") && lacks(text(teamListed), "payroll.csv"),
  );
}
