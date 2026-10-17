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

### Letting someone in off the waitlist puts their phone on the list

Decided by the owner, 2026-10-17: keep the free shared line, twenty contacts,
for now, and "letting someone off the wait list automatically puts them into
that list." Let in adds the row's phone, or, for a row joined with an
address, the proven phone of the account that proved that address
(`functions/waitlistTex.ts`). An address with no phone yet is added when that
person confirms one in the app (`phoneCheck.recordConfirmedPhone`); linking a
phone by texting Tex cannot be the moment, because a number off the list
cannot text Tex at all.

A full list, a line with no list, or Linq failing never fails the Let in. A
refusal is logged and goes on the admin trail as `tex.allowlist_refused` under
the staff member who let the row in, with the outcome and the last four
digits; an addition is `tex.allowlist_added` with `via: "waitlist"`. Staff
then free a slot or add the number from Tex access, which reads Linq's list
and shows the new number under its account.

The "You're in" text comes from the Messaging Service, not from Tex's line, so
it cannot say "reply here". It names Tex's number, which Linq reports with the
list and so needs no new setting, only once the phone is on the list: the add
runs first in the same action, and a refused add sends the old wording. A
"text Tex" that the line would never deliver is the thing this ordering
prevents. Test: `apps/convex/__tests__/waitlistTex.test.ts`, "puts the phone on
Tex's list before the text, and the text names Tex" and "a full list never
fails the Let in".
