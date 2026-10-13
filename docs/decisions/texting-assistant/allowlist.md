# The texting assistant — who may text the line

_Part of [the texting assistant](../texting-assistant.md)._

### Who may text the line is Linq's list, managed from the console

Requested by the owner, 2026-10-13: "we only have 20 slots with the linq
trial". Linq's free shared line passes on a text only from a number on its
contact list, at most twenty, and a number off the list is never delivered,
so nothing on our side can see it. The staff console's Agent tab has a "Who
can text Tex" panel that reads that list, says whose each number is (the
account it is linked to for texting, or the one that signs in with it), adds a
number and frees a slot. A twenty-first is refused in the console before Linq
is asked.

Linq keeps the list and we keep no copy: a copy would drift the first time
someone used `linq contacts add`, and the slots are Linq's to count. The calls
are the ones Linq's own CLI makes (`/cli/account-info`, `/cli/contacts`,
`/cli/contacts/add`, `/cli/contacts/remove` on Linq's service) with the same
`LINQ_API_KEY` the Worker replies with, which the deploy now also sets on the
control plane. A paid line has no list, and the panel says anybody can text
it. Changes go on the admin trail with the last four digits only. Test:
`apps/convex/__tests__/texAllowlist.test.ts`, "the twentieth fits and the
twenty-first is refused before Linq is asked".
