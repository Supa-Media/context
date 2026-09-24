import { useMemo } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import type { DomainSettings } from "./domain";

/** A short link the domain's root could open: anyone can read it, and it has a name. */
export interface HomepageChoice {
  slug: string;
  title: string;
}

export interface DomainActions {
  connect: (hostname: string) => Promise<void>;
  checkNow: () => Promise<void>;
  setHomepage: (slug: string | null) => Promise<void>;
  remove: () => Promise<void>;
}

export interface DomainPanelView {
  settings: DomainSettings | undefined;
  failed: boolean;
  homepageChoices: HomepageChoice[];
  /** Absent, as a whole object, for anybody who is not an owner. */
  actions?: DomainActions;
}

interface ShareRow {
  audience: string;
  slug?: string;
  entryPath: string;
  previewTitle?: string;
}

function titleFor(share: ShareRow): string {
  if (share.previewTitle !== undefined && share.previewTitle.trim() !== "") return share.previewTitle;
  const leaf = share.entryPath.split("/").filter(Boolean).pop() ?? share.entryPath;
  return leaf.replace(/\.md$/i, "");
}

/**
 * The Website section's data: the settings query, and — for an owner only —
 * the short links that could be the homepage.
 *
 * Subscribed, so the panel follows the checker on its own: a record found, a
 * certificate issued, the pill turning green. Nothing here polls.
 */
export function useDomain(workspaceId: string | null): DomainPanelView {
  const settingsSpec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null) return EMPTY_QUERY_SPEC;
    return {
      settings: {
        query: api.functions.customDomains.settings,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      },
    };
  }, [workspaceId]);
  const settingsResult = useQueries(settingsSpec).settings as DomainSettings | Error | undefined;
  const settings = settingsResult instanceof Error ? undefined : settingsResult;
  const canManage = settings?.canManage === true;

  const sharesSpec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !canManage) return EMPTY_QUERY_SPEC;
    return {
      shares: {
        query: api.functions.shares.listShares,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      },
    };
  }, [workspaceId, canManage]);
  const sharesResult = useQueries(sharesSpec).shares as ShareRow[] | Error | undefined;

  const connect = useMutation(api.functions.customDomains.connect);
  const checkNow = useMutation(api.functions.customDomains.checkNow);
  const setHomepage = useMutation(api.functions.customDomains.setHomepage);
  const remove = useMutation(api.functions.customDomains.remove);

  const homepageChoices = useMemo<HomepageChoice[]>(() => {
    if (!Array.isArray(sharesResult)) return [];
    return sharesResult
      .filter((share) => share.audience === "anyone" && typeof share.slug === "string")
      .map((share) => ({ slug: share.slug as string, title: titleFor(share) }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }, [sharesResult]);

  const domainId = settings?.domain?.id ?? null;
  const actions = useMemo<DomainActions | undefined>(() => {
    if (workspaceId === null || !canManage) return undefined;
    const id = domainId as Id<"customDomains"> | null;
    return {
      connect: async (hostname) => {
        await connect({ workspaceId: workspaceId as Id<"workspaces">, hostname });
      },
      checkNow: async () => {
        if (id !== null) await checkNow({ domainId: id });
      },
      setHomepage: async (slug) => {
        if (id !== null) await setHomepage({ domainId: id, slug });
      },
      remove: async () => {
        if (id !== null) await remove({ domainId: id });
      },
    };
  }, [workspaceId, canManage, domainId, connect, checkNow, setHomepage, remove]);

  return {
    settings,
    failed: settingsResult instanceof Error,
    homepageChoices,
    ...(actions === undefined ? {} : { actions }),
  };
}
