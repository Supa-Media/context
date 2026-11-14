/**
 * People: the artifact's `P.people` (its markup, texts and behaviour) on the console's data. The
 * HTML and acts live in `./people/`; this file is the hooks that feed them.
 *
 * The list is three paginated queries (accounts, waitlist, invites) and one usage query (AI spend,
 * last sign-in and clients, invites paused, truncated), assembled into the one shape the page draws.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { S } from "../state";
import type { ConsolePage } from "../types";
import { acts } from "./people/acts";
import { props as propsOf, render as renderPeople } from "./people/render";
import {
  failureText,
  type ConsolePeople,
  type InviteRow,
  type Person,
  type PeopleData,
  type PeopleMutations,
  type TexLine,
  type WaitRow,
} from "./people/model";

/** Keeps asking for the next page of a paginated query until all of it is here. */
function useLoadAll(page: { status: string; loadMore: (n: number) => unknown }, pageSize: number): void {
  const { status, loadMore } = page;
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(pageSize);
  }, [status, loadMore, pageSize]);
}

/**
 * Everyone, as the People page's model: undefined until the first page of each list and the usage
 * have loaded, then the rows as they stand (a list still loading more renders what it has).
 */
function useEveryone(): ConsolePeople | undefined {
  const accounts = usePaginatedQuery(api.functions.consolePeople.accountsPage, {}, { initialNumItems: 100 });
  const waitlist = usePaginatedQuery(api.functions.consolePeople.waitlistPage, {}, { initialNumItems: 500 });
  const invites = usePaginatedQuery(api.functions.consolePeople.invitesPage, {}, { initialNumItems: 500 });
  const usage = useQuery(api.functions.consolePeople.peopleUsage, {});
  useLoadAll(accounts, 500);
  useLoadAll(waitlist, 500);
  useLoadAll(invites, 500);

  return useMemo<ConsolePeople | undefined>(() => {
    if (usage === undefined) return undefined;
    if (accounts.status === "LoadingFirstPage" || waitlist.status === "LoadingFirstPage" || invites.status === "LoadingFirstPage") return undefined;

    const spend = new Map(usage.spend.map((s) => [s.userId as string, s]));
    const grants = new Map(usage.clients.map((c) => [c.userId as string, c]));
    const people: Person[] = accounts.results.map((a) => {
      const g = grants.get(a.userId);
      const s = spend.get(a.userId);
      return {
        ...a,
        lastSeenAt: g?.lastSeenAt ?? null,
        clients: g?.clients ?? [],
        aiUsd: s?.aiUsd ?? 0,
        aiByFeature: s?.aiByFeature ?? [],
      };
    });

    // An address or phone an account holds is that account's, so its waitlist row is not listed twice.
    const held = new Set<string>();
    for (const p of people) {
      for (const e of p.emails) held.add(e);
      if (p.phone !== null) held.add(p.phone);
      for (const t of p.textingPhones) held.add(t);
    }
    const waiting = waitlist.results.filter(
      (w): boolean => !((w.email !== null && held.has(w.email)) || (w.phone !== null && held.has(w.phone))),
    ) as WaitRow[];
    const open = invites.results.filter((i): i is InviteRow => i.status !== "joined");

    return { accounts: people, waitlist: waiting, invites: open, invitesOff: usage.invitesOff, truncated: usage.truncated };
  }, [accounts.status, accounts.results, waitlist.status, waitlist.results, invites.status, invites.results, usage]);
}

function usePeopleData(): PeopleData {
  const people = useEveryone();
  const inboxes = useQuery(api.functions.consolePeople.openInboxes, {});
  // The account picked in the side panel, when it is one: its AI costs are read for today's limits.
  const pickedAccount = people !== undefined && S.x !== null && people.accounts.some((a) => a.userId === S.x) ? S.x : null;
  const acct = useQuery(api.functions.admin.aiCostsAccount, pickedAccount ? { userId: pickedAccount, days: 30 } : "skip");

  // Tex's list is read by an action, once on open and again after each change; kept in React state.
  const readTex = useAction(api.functions.admin.texAllowlist);
  const readRef = useRef(readTex);
  readRef.current = readTex;
  const [tex, setTex] = useState<TexLine | undefined>(undefined);
  const refreshTex = useCallback(async (): Promise<TexLine> => {
    let line: TexLine;
    try {
      line = (await readRef.current({})) as TexLine;
    } catch (error) {
      line = { state: "error", error: failureText(error, "Tex's list could not be read.") } as TexLine;
    }
    setTex(line);
    return line;
  }, []);
  useEffect(() => {
    void refreshTex();
  }, [refreshTex]);

  const fns = {
    admit: useMutation(api.functions.admin.admitWaitlist),
    remove: useMutation(api.functions.admin.removeFromWaitlist),
    restore: useMutation(api.functions.consolePeople.restoreWaitlist),
    tell: useMutation(api.functions.consolePeople.tellLetIn),
    addToWaitlist: useMutation(api.functions.admin.addToWaitlist),
    setPhone: useMutation(api.functions.admin.setPersonPhone),
    setArchived: useMutation(api.functions.admin.setPersonArchived),
    revoke: useMutation(api.functions.admin.revokeReferral),
    setInvitesOff: useMutation(api.functions.admin.setInvitesOff),
    closeInbox: useMutation(api.functions.consolePeople.closeInbox),
    changeTex: useAction(api.functions.admin.changeTexAllowlist),
  };
  // The write functions are read through a ref, so the data object below changes only when the data does.
  const fnsRef = useRef(fns);
  fnsRef.current = fns;
  const m = useMemo<PeopleMutations>(
    () => ({
      admit: (a) => fnsRef.current.admit(a),
      remove: (a) => fnsRef.current.remove(a),
      restore: (a) => fnsRef.current.restore(a),
      tell: (a) => fnsRef.current.tell(a),
      addToWaitlist: (a) => fnsRef.current.addToWaitlist(a),
      setPhone: (a) => fnsRef.current.setPhone(a),
      setArchived: (a) => fnsRef.current.setArchived(a),
      revoke: (a) => fnsRef.current.revoke(a),
      setInvitesOff: (a) => fnsRef.current.setInvitesOff(a),
      closeInbox: (a) => fnsRef.current.closeInbox(a),
      changeTex: (a) => fnsRef.current.changeTex(a),
      texRefresh: () => refreshTex(),
    }),
    [refreshTex],
  );

  // One inbox per workspace; the account holding it is what the panel asks about.
  const mailOpen = useMemo(() => new Set<string>((inboxes ?? []).map((i) => i.userId)), [inboxes]);
  return useMemo<PeopleData>(
    () => ({ people, mailOpen, tex, acct: acct as PeopleData["acct"], m }),
    [people, mailOpen, tex, acct, m],
  );
}

export const peoplePage: ConsolePage<PeopleData> = {
  key: "people",
  filters: { aud: "all", ans: "0", told: "all", ps: "all", cf: "all", sort: "lastup" },
  windowed: false,
  useData: usePeopleData,
  render: (d) => renderPeople(d),
  props: (d, x) => propsOf(d, x),
  acts,
};
