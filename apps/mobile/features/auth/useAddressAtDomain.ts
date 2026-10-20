import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { settingsHref } from "../console/nav";

/**
 * For a shared link read at an address its workspace's domain does not open
 * (board 05): the reader's own address, for "You're signed in as …", and
 * Account settings in their own workspace, where they add one at the domain.
 * Asked only while `enabled`. Kept out of `features/share/`, whose files reach
 * for nothing but the share read path (`shareReadOnly.test.ts`).
 */
export function useAddressAtDomain(enabled: boolean): { email: string | null; addEmail: () => void } {
  const router = useRouter();
  const setup = useQuery(api.functions.accountSetup.mySetup, enabled ? {} : "skip");
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, enabled ? {} : "skip");
  const ownSlug = workspaces?.find((row) => row.kind === "personal" && row.role === "owner")?.slug ?? null;
  const addEmail = useCallback(() => {
    router.push(ownSlug === null ? "/console" : settingsHref(ownSlug, "profile"));
  }, [ownSlug, router]);
  return { email: setup?.email ?? null, addEmail };
}
