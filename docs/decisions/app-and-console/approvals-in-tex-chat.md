# App and console: approvals are answered in the chat with Tex

## Approvals are cards in the Tex chat, and there is no Approvals tab (2026-11-19)

Decided by the owner, 2026-11-19: *"no approvals tab, just make the approvals
happen right inside the message box"*. What the egress gate holds for a
person's yes (an AI client's held call, a vault key's first use, a card at a
checkout) is drawn as a card in the right panel's Tex chat, placed in the
conversation at the moment it was asked, with Approve and Decline (and "Yes,
from now on" for a key's first use). Tex's own asks on its texts are drawn as
the same kind of card under the text that asked. A press goes to the same
backend as before (`POST /approvals`, or the 👍/👎 answer on Tex's text), and the
card shows Approved or Declined without a reload. The Tex tab carries the count
of what is waiting, so somebody on the Meetings tab still sees it.

The Approvals tab, which appeared only when something was waiting or the list
failed, is gone with `ApprovalsPanel`.

**The listing asks only the person's own memberships.** The pinned context
(`@context-lc`) is reach, not membership, and the control plane refuses a
console grant for it by design. Listing it made every account that is not a
member of it see "I could not reach your context" with nothing waiting
(google-review account, 2026-11-19), and because a failed listing was the only
thing that made the old tab appear, the error was all the tab ever showed them.
`features/approvals/scope.ts` leaves it out.

**What a simplification of this would cost.** Putting a second approvals
surface back beside the chat splits one decision across two places again.
`asideTabs.test.ts` fails if an `approvals` tab returns,
`texApprovalCard.test.ts` if a card stops calling the backend or showing its
outcome, and `approvalsScope.test.ts` and `approvalsHook.test.ts` if the pinned
context is asked again.
