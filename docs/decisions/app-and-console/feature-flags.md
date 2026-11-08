# Feature flags: one id per feature, who has it chosen in the console

## Each unfinished feature has its own flag, and every flag expires (2026-11-08)

Decided by the owner, 2026-11-08: *"instead of just making a 'isDogfood' flag,
i'd prefer if each feature had a unique Id or something and then in the staff
dashboard allow me to add or remove users to a feature list, Id like for this
to add almost no latency at all"*, then *"would need a way to enable a feature
for a group of users that I know i would be consistently testing with"* and
*"put expiration dates on flags, either remove the feature or launch it"*. The
design was approved as drawn, with its three defaults (a group chat counts the
sender's flags; groups as well as people; Context first, the generic parts to
supa-framework later).

- **The ids live in code**, in `packages/shared/src/flags.cjs`, read by the
  control plane, the gateway and the app. An id is `area.name` in lower-case
  words joined by hyphens, and is never reused.
- **Who has a flag lives in Convex**: `featureFlags` (its mode: `off`,
  `people`, `everyone`; a missing row is off), `featureFlagPeople` (people by
  name), `testerGroups` and `testerGroupPeople` (saved groups such as Dogfood
  or Friends and family) and `featureFlagGroups` (a group on a flag's list).
  In `people` mode a flag is on for the people named and everyone in a group
  on its list. The lists never go in the repository: it is public, and who is
  testing what is theirs.
- **Staff manage it in the console's Features tab**
  (`functions/featureFlags.ts`, `apps/mobile/features/admin/FeaturesSection.tsx`):
  staff only (`requireAdmin`, so the second factor applies), every change in
  the admin audit trail. Ids with rows but no flag in code are listed under
  "Launched or removed" with a Clear button.
- **Every flag expires.** `expires` is at most 90 days after `added`
  (`MAX_FLAG_DAYS`), the console shows the countdown and turns it amber in the
  last 14 days, and once it passes `flagProblems` names the flag and
  `apps/convex/__tests__/featureFlags.test.ts` fails, so CI is red until a pull
  request launches the feature (deletes the flag, keeps the code) or removes
  it. Editing `expires` later is held to the same 90 days from `added`.
- **Off is the answer for anything unsure**: an id not in code, no row, a
  person not on the list, nobody signed in.
- **A flag only turns code on.** It never widens what anyone can see; the
  privacy engine does not read flags.

Reading one: `flagOnFor(ctx, userId, id)`, `peopleWithFlag(ctx, id)` and
`flagsFor(ctx, userId)` in `apps/convex/functions/lib/featureFlags.ts`; the
app's own set is `functions/featureFlags:myFlags`, a live query.

**What replacing it costs.** A single "dogfood" switch is what the owner
turned down: it cannot open one feature to one tester. Dropping the expiry
check lets flags pile up, which is what the old Features tab did with vault
key use, left switched on for everyone long after it needed a switch.

## Vault key use is launched, and the old switches are gone (2026-11-08)

The owner, 2026-11-08: *"let's clean up the vault flag, it's been on for
ages"*. Every session's store now carries `vaultProxy`
(`apps/mcp/src/sessionStore.js`), `/gateway/binding` no longer carries a
`features` sibling, and `functions/featureSwitches.ts` is deleted. That old
switch also took up to about four minutes to apply, because it rode in the
storage binding the workspace object keeps (`FRESH_MS`) and a switch did not
clear it. The `featureSwitches` table's definition stays only until each
deployment has run the "Drain retired tables" workflow
(`functions/retiredTables:drainFeatureSwitches`), as `organizerSettings` does
([removed-features](./removed-features.md)). The check:
`apps/mcp/test/vaultLaunched.test.mjs`.
