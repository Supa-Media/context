/**
 * People: the artifact's `P.people` (its markup, texts and behaviour) on the console's data. The
 * HTML and acts live in `./people/`; this file is the hooks that feed them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { S } from "../state";
import type { ConsolePage } from "../types";
import { acts } from "./people/acts";
import { props as propsOf, render as renderPeople } from "./people/render";
import { failureText, type AiAccount, type PeopleData, type PeopleMutations, type TexLine } from "./people/model";

function usePeopleData(): PeopleData {
  const people = useQuery(api.functions.consolePeople.everyone, {});
  const inboxes = useQuery(api.functions.consolePeople.openInboxes, {});
  // The account picked in the side panel, when it is one: its AI costs are read for today's limits.
  const pickedAccount = people !== undefined && S.x !== null && people.accounts.some((a) => a.userId === S.x) ? S.x : null;
  const acct = useQuery(api.functions.admin.aiCostsAccount, pickedAccount ? { userId: pickedAccount, days: 30 } : "skip");

  // Tex's list is read by an action, once on open and again after each change; kept in React state.
  const readTex = useAction(api.functions.admin.texAllowlist);
  const readRef = useRef(readTex);
  readRef.current = readTex;
  const [tex, setTex] = useState<TexLine | undefined>(undefined);
  const refreshTex = useCallback(async () => {
    try {
      setTex((await readRef.current({})) as TexLine);
    } catch (error) {
      setTex({ state: "error", error: failureText(error, "Tex's list could not be read.") });
    }
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
    () => ({ people, mailOpen, tex, acct: acct as AiAccount | null | undefined, m }),
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
