# People and agents working now share one bar, and it counts only who is active

Decided by the owner, 2026-09-28: a workspace shows how many people have it
open, on the same bar as "N agents active", drawn by the same component
(`ActiveParts`), and never how many members it has.

- **Active means the console is open in a visible tab.** Every open console
  already asks `GET /agent-activity` every half minute while visible; that ask
  is the person's heartbeat (`apps/mcp/src/peopleActive.js`). Someone stops
  counting about a minute after their tab hides or closes. It is not "opened
  this week": the bar is about now, like the agents half beside it.
- **Only the console counts as a person.** A tool holding a grant can call the
  same route, and it is counted as an agent by what it reads and writes;
  counting it twice would put a robot in the people number.
- **Held like the agents log**: in the workspace activity object's memory
  only, never storage, keyed by a digest of the account id (not the id), with
  a name and a time and no note path.
- **The viewer alone is not news.** Nothing is said about people until
  somebody else is active, so a personal workspace never shows it; once they
  are, the count includes the viewer.
- **The homepage draws the same bar** with a demo crowd
  (`HOMEPAGE_PEOPLE_ACTIVE`) and the cast's own people as faces, never a
  homepage-only copy.

Reversing it: showing membership ("300 people") re-adds the number the owner
asked to drop, and splitting people from agents re-adds the second bar. The
checks that fail are in `apps/mcp/test/agentActivity.test.mjs` ("a tool asking
is not a person…") and `apps/mobile/__tests__/agentActivityView.test.ts`
("only the active number is shown…").
