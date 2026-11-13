# The Architecture Lab is a staff page, built exactly like its artifact (2026-11-13)

Dev2 designed the Tex Architecture Lab as an artifact on 2026-11-13: change
Tex's steps, wires, each step's model and context modules on a canvas, see
what that does to reply time and cost, edit the bench's test cases, and hand
the version to the replay gate. The same day Dev2 asked for it to be built for
real, "EXACTLY like the artifact with all the functionality wired up".

**Where:** context.lc/lab and tex.lc/lab (`apps/mobile/app/(app)/lab.tsx`;
Dev2, 2026-11-13), reached like the staff console, by typing the address;
`/admin/lab`, where it first opened, redirects there. Staff only on
the server: `apps/convex/functions/texLab.ts`, `requireAdmin` in every
handler. Saved versions and case edits are two tables every staff member
shares (`texLabVersions`, `texLabCaseEdits`); they hold the Lab's own JSON
(graphs of steps and wires, edits to the bench's public cases), never a note
or anyone's chat.

**The artifact is the spec.** The stylesheet is its `<style>` scoped under
`.tl` (`features/tex/lab/labCss.ts`), the shell is its markup with the same
ids and classes, the constants are copied verbatim (`features/tex/lab/data/`),
and the engine keeps its function names and its one state
(`features/tex/lab/engine/`). `__tests__/texLabEngine.test.ts` holds the port
to the numbers the artifact's own page computed. A view that looks or acts
differently from the artifact is a bug, unless it is one of the stated
differences below. `node scripts/tex-lab-preview.mjs` builds the page with
Convex stood in, so the two can be screenshot side by side.

**Stated differences:** saving goes to Convex rather than the artifact's page
database ("Shared · n saved versions"), and the Tools page also reads live
tool figures.

**Its data is the bench's own.** `scripts/tex-lab-data.mjs` writes the cases,
the module texts (the map, the capability list, the judge examples, the test
person's about note) and the test workspaces from the repo into
`labData.generated.ts`. Fast repository guards fails when that file is stale.

**What a simplification would cost:** rebuilding the views "in the app's own
style" instead of porting them would bring back the thing Dev2 named, a build
that isn't what was designed; keeping versions in browser storage would lose
the comparison between staff members' versions, which is half the point.
