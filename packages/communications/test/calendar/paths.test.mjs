import { calendarDayNotePath, isCalendarDayDate, isCalendarDayNotePath, parseCalendarDayPath } from "../../src/calendar/paths.js";
import { CALENDAR_FOLDER } from "../../src/calendar/protocol.js";

export function runCalendarPathChecks(check) {
  check("the calendar folder is under the one inbox root", CALENDAR_FOLDER === "0-inbox/calendar");

  check("a real date validates", isCalendarDayDate("2026-09-07"));
  check("2026-02-30 does not exist and is refused", !isCalendarDayDate("2026-02-30"));
  check("2026-13-01 has no thirteenth month and is refused", !isCalendarDayDate("2026-13-01"));
  check("a non-date value is refused", !isCalendarDayDate("hello") && !isCalendarDayDate(20260907) && !isCalendarDayDate(null));

  check("calendarDayNotePath is flat, one file per day", calendarDayNotePath({ date: "2026-09-07" }) === "0-inbox/calendar/2026-09-07.md");
  check(
    "a root prefix is applied at the boundary, never derived",
    calendarDayNotePath({ date: "2026-09-07" }, { root: "vault" }) === "vault/0-inbox/calendar/2026-09-07.md"
  );
  check(
    "a configured destination folder replaces the default Calendar folder",
    calendarDayNotePath({ date: "2026-09-07" }, { folder: "2-areas/schedule" }) === "2-areas/schedule/2026-09-07.md"
  );
  check(
    "the customer root still wraps a configured destination",
    calendarDayNotePath({ date: "2026-09-07" }, { root: "vault", folder: "2-areas/schedule" }) === "vault/2-areas/schedule/2026-09-07.md"
  );
  check("a traversing destination is refused instead of escaping the bucket folder", (() => {
    try {
      calendarDayNotePath({ date: "2026-09-07" }, { folder: "../elsewhere" });
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })());
  check("an invalid date throws rather than writing a bad path", (() => {
    try {
      calendarDayNotePath({ date: "not-a-date" });
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })());

  check(
    "parseCalendarDayPath round-trips through calendarDayNotePath",
    JSON.stringify(parseCalendarDayPath(calendarDayNotePath({ date: "2026-09-07" }))) === JSON.stringify({ date: "2026-09-07" })
  );
  check(
    "...and round-trips with a root too",
    JSON.stringify(parseCalendarDayPath(calendarDayNotePath({ date: "2026-09-07" }, { root: "vault" }), { root: "vault" })) ===
      JSON.stringify({ date: "2026-09-07" })
  );
  check(
    "...and round-trips with a configured destination",
    JSON.stringify(parseCalendarDayPath(calendarDayNotePath({ date: "2026-09-07" }, { folder: "2-areas/schedule" }), { folder: "2-areas/schedule" })) ===
      JSON.stringify({ date: "2026-09-07" })
  );
  check("a path outside the calendar folder is not one of ours", parseCalendarDayPath("0-inbox/email/x/2026-09-07.md") === null);
  check("a subfolder under calendar/ is not one of ours — nothing this module writes goes deeper", parseCalendarDayPath("0-inbox/calendar/2026/2026-09-07.md") === null);
  check("a day that does not exist is refused even though the pattern matches", parseCalendarDayPath("0-inbox/calendar/2026-02-30.md") === null);
  check("a non-string is refused without throwing", parseCalendarDayPath(undefined) === null && parseCalendarDayPath(42) === null);
  check(
    "a root-scoped path is refused with no root option, and vice versa",
    parseCalendarDayPath("vault/0-inbox/calendar/2026-09-07.md") === null &&
      parseCalendarDayPath("0-inbox/calendar/2026-09-07.md", { root: "vault" }) === null
  );

  check("isCalendarDayNotePath agrees with the parser", isCalendarDayNotePath(calendarDayNotePath({ date: "2026-09-07" })));
  check("...in the negative too", !isCalendarDayNotePath("0-inbox/calendar/Work_Box/2026-09-07.md"));

  // -- tenancy: the non-negotiable, checked directly ------------------------
  //
  // The only prefix allowed is `root`, the customer's own chosen folder,
  // applied verbatim — nothing this module derives from a workspace or
  // account id may appear beside it. Passing a `root` that happens to look
  // like a workspace path (a caller's mistake, not this module's business) is
  // still just concatenated once, with no other segment invented.
  check(
    "a path is exactly <root>/0-inbox/calendar/<date>.md — no id this module invents in between",
    calendarDayNotePath({ date: "2026-09-07" }, { root: "workspaces/acme" }) === "workspaces/acme/0-inbox/calendar/2026-09-07.md"
  );
  check("with no root, the path starts at the inbox itself", calendarDayNotePath({ date: "2026-09-07" }).startsWith("0-inbox/"));

  // -- sabotage record --------------------------------------------------
  //
  // Dropped the `rest.includes("/")` guard in `parseCalendarDayPath` — **0**
  // checks failed, and that is written down rather than dropped, the way
  // `docs/decisions/communications.md`'s own "0 checks failed" sabotage note
  // is: `DAY_FILE` is anchored `^...$`, so `2026/2026-09-07.md` already fails
  // the regex on its own and the guard is redundant with it today. It stays,
  // because `DAY_FILE` being anchored is a property of *that* regex, not a
  // promise the rest of this file can lean on forever — the guard is what
  // keeps a future, less careful `DAY_FILE` from quietly accepting a
  // subfolder. Confirmed by testing a case the anchoring cannot save: a
  // subfolder holding a real day file at its own top level would need a
  // second, independent look to catch, which is what this guard is.
}
