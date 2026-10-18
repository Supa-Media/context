# Privacy and sharing — the share dialog edits a row's list

### The share dialog writes a list and its base together, and a domain is never a grantee (2026-10-17)

Where rows are the truth, the share dialog shows one row's list (its own, or the
nearest folder's it follows) and edits it: people, groups and emails, each with
**Can view** or **Can edit** (Dev2's boards 1 to 4, 2026-10-16). The read is
`nodesAccess.shareList`, owner-only; the write is `nodesAccess.setGrantees` with
`base`, so the list and what the rest of the workspace gets change in one write.

**Why the base travels with the list.** `rowAccess.ts` reads a row that has a
list and no base of its own as private, failing closed. So naming one person on
a note that follows a team folder, as a list alone, would shut every other
member out without anyone choosing that. The dialog always writes the base the
note already reads as (`grants.ts`, `baseFor`); a simplification that sends the
list alone fails "adding a member with edit writes the whole list" in
`apps/mobile/__tests__/shareGrantsDialog.test.ts`.

**The general access control keeps the list.** `consoleAccess` used to reset a
note to inherit when the chosen tier matched its folder, and inherit clears the
list, so letting the workspace in removed everyone named on the note. A listed
note now keeps its own base (`apps/convex/__tests__/nodes/shareList.test.ts`,
"letting the workspace in keeps the list").

**Grantees by id.** `setGrantees` takes a `userId` for a member, or for someone a
list in this workspace already names, so the dialog can send back the list it
shows. Anyone else is named by email; a stranger's id gets the same
`GRANTEE_NOT_FOUND` as a malformed one.

**A domain is not a grantee.** Non-negotiable 5: every grantee is a person or an
email awaiting one. Typing a domain offers "Everyone at …" only when the
workspace lets that domain join (Settings, Sharing), and picking it lets the
workspace in (team), since everyone there becomes a member when they sign in.
A domain that is not set to join is shown with where to turn it on, and nothing
can be pressed.

**Folders.** A note that follows a folder shows the folder's list read-only and
offers "Give this note its own list", which copies it; "Go back to sharing like
the folder" sends `base: "inherit"` with an empty list (a list with inherit is
refused, so nothing is left as a hidden grant).
