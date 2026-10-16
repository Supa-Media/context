# The texting assistant — who may text the line

_Part of [the texting assistant](../texting-assistant.md)._

### Who may text the line is Linq's list, managed from the console

Requested by the owner, 2026-10-13: "we only have 20 slots with the linq
trial". Linq's free shared line passes on a text only from a number on its
contact list, at most twenty, and a number off the list is never delivered,
so nothing on our side can see it. The staff console's Growth roster has a
Tex access switch on each account (moved there from an Agent tab panel the
same day: "it should be a toggle I can set in the growth tab connected to
their account"). The account's number is the one linked to it for texting,
else its verified sign-in phone, and is shown under its email. A number on the
list that is no shown account is listed under the roster with Remove, so its
slot can always be freed. A number with no account yet can be typed in under
the roster too (2026-10-16): a friend Dev2 handed Tex's contact to texted
before signing up and heard nothing, because only accounts had a switch. A twenty-first is refused in the console before Linq
is asked, and the switches that would add one are disabled.

Linq keeps the list and we keep no copy: a copy would drift the first time
someone used `linq contacts add`, and the slots are Linq's to count. The calls
are the ones Linq's own CLI makes (`/cli/account-info`, `/cli/contacts`,
`/cli/contacts/add`, `/cli/contacts/remove` on Linq's service) with the same
`LINQ_API_KEY` the Worker replies with, which the deploy now also sets on the
control plane. A paid line has no list, and the panel says anybody can text
it. Changes go on the admin trail with the last four digits only. Test:
`apps/convex/__tests__/texAllowlist.test.ts`, "the twentieth fits and the
twenty-first is refused before Linq is asked".
