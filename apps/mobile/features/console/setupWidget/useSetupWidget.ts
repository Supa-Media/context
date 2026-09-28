import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { openStore } from "../../offline/store";
import type { GrantFacts } from "../../onboarding/tools";

/**
 * Where "put the setup widget away" is remembered on this device, per
 * workspace.
 *
 * No longer the record — the membership's `setupRetiredAt` is, so the card
 * stays away on every origin and device (a device flag alone brought it back
 * on staging, the desktop app and any browser with cleared site data, under a
 * card promising it would not). The device flag stays as the fast first
 * answer, and as the way a dismissal made before the account field existed
 * reaches the account. The rows themselves are never stored — each is read
 * from a fact every time (`rules.ts`).
 */
export function setupWidgetRetiredKey(workspaceId: string): string {
  return `context.lc.setup-widget.retired.v1.${workspaceId}`;
}

/**
 * Put away for this person here: on their account, or on this device.
 * `undefined` only while the device has not answered and the account has not
 * said yes.
 */
export function setupRetired(
  account: boolean | undefined,
  device: boolean | undefined,
): boolean | undefined {
  if (account === true || device === true) return true;
  return device;
}

/**
 * The widget's live inputs: the grants list its tools row reads, and whether
 * this person has put it away (`account`, from their membership row).
 *
 * `retired` starts `undefined` and the widget is not drawn until the device
 * answers — a card that appears and vanishes on every load for everybody who
 * already put it away is the layout jump `useContextIntro` refuses too. A read
 * that fails counts as put away: a card nobody can dismiss durably is worse
 * than no card, and every row's fact is on its own screen anyway.
 */
export function useSetupWidget(
  workspaceId: string | null,
  enabled: boolean,
  account: boolean | undefined,
) {
  const grants = useQuery(
    api.functions.grants.listGrants,
    enabled && workspaceId !== null ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip",
  ) as GrantFacts[] | undefined;

  const retireOnAccount = useMutation(api.functions.workspaces.retireSetupWidget);
  const key = workspaceId === null ? null : setupWidgetRetiredKey(workspaceId);
  /*
    `found`: the flag was actually read off this device, as opposed to a read
    that failed (counted as put away, see above) or a press in this session
    (which tells the account itself). Only a found flag is carried up.
  */
  const [answer, setAnswer] = useState<{ key: string; retired: boolean; found: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (key === null || !enabled) return;
    let live = true;
    void openStore()
      .get(key)
      .then((stored) => {
        if (live) setAnswer({ key, retired: stored !== null, found: stored !== null });
      })
      .catch(() => {
        if (live) setAnswer({ key, retired: true, found: false });
      });
    return () => {
      live = false;
    };
  }, [enabled, key]);

  const current = answer !== null && answer.key === key ? answer : null;
  const device = current?.retired;
  const found = current?.found === true;

  const retire = useCallback(() => {
    if (key === null || workspaceId === null) return;
    setAnswer({ key, retired: true, found: false });
    /*
      Both, and the account is the one that counts: the device write throws
      when `localStorage` is full — the offline cache fills it on a busy
      console — and a flag kept only here then brought the card back on every
      refresh.
    */
    void openStore()
      .set(key, "1")
      .catch(() => {});
    void retireOnAccount({ workspaceId: workspaceId as Id<"workspaces"> }).catch(() => {});
  }, [key, workspaceId, retireOnAccount]);

  /*
    A dismissal this device remembers from before the account held it: carry
    it up once, so the other devices stop asking too. `account === false`, not
    `!== true` — an old cached row that does not know the field yet says
    nothing either way.
  */
  useEffect(() => {
    if (!enabled || workspaceId === null || !found || account !== false) return;
    void retireOnAccount({ workspaceId: workspaceId as Id<"workspaces"> }).catch(() => {});
  }, [enabled, workspaceId, found, account, retireOnAccount]);

  return {
    grants: grants instanceof Error ? undefined : grants,
    retired: setupRetired(account, device),
    retire,
  };
}
