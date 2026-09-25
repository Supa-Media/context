import { useCallback, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { openStore } from "../../offline/store";
import type { GrantFacts } from "../../onboarding/tools";

/**
 * Where "put the setup widget away" is remembered, per workspace.
 *
 * A device flag, for `contextIntro.ts`'s reason: whether somebody has finished
 * looking at a checklist is a fact about a person on a screen, nothing else
 * can observe it, and no control-plane table holds it. The rows themselves are
 * never stored — each is read from a fact every time (`rules.ts`).
 */
export function setupWidgetRetiredKey(workspaceId: string): string {
  return `context.lc.setup-widget.retired.v1.${workspaceId}`;
}

/**
 * The widget's live inputs: the grants list its tools row reads, and whether
 * this device has put it away.
 *
 * `retired` starts `undefined` and the widget is not drawn until the device
 * answers — a card that appears and vanishes on every load for everybody who
 * already put it away is the layout jump `useContextIntro` refuses too. A read
 * that fails counts as put away: a card nobody can dismiss durably is worse
 * than no card, and every row's fact is on its own screen anyway.
 */
export function useSetupWidget(workspaceId: string | null, enabled: boolean) {
  const grants = useQuery(
    api.functions.grants.listGrants,
    enabled && workspaceId !== null ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip",
  ) as GrantFacts[] | undefined;

  const key = workspaceId === null ? null : setupWidgetRetiredKey(workspaceId);
  const [answer, setAnswer] = useState<{ key: string; retired: boolean } | null>(null);

  useEffect(() => {
    if (key === null || !enabled) return;
    let live = true;
    void openStore()
      .get(key)
      .then((stored) => {
        if (live) setAnswer({ key, retired: stored !== null });
      })
      .catch(() => {
        if (live) setAnswer({ key, retired: true });
      });
    return () => {
      live = false;
    };
  }, [enabled, key]);

  const retire = useCallback(() => {
    if (key === null) return;
    setAnswer({ key, retired: true });
    void openStore()
      .set(key, "1")
      .catch(() => {});
  }, [key]);

  return {
    grants: grants instanceof Error ? undefined : grants,
    retired: answer !== null && answer.key === key ? answer.retired : undefined,
    retire,
  };
}
