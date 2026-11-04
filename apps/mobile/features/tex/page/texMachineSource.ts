/**
 * The page's source with the person's computers on the gateway's own routes
 * (`texMachineGateway.ts`): `machines()` reads `/machines/app/list`, the
 * machine actions go to `/machines/app/*`, the person's own overview carries
 * the asks waiting on their computers, and a pairing code from the address is
 * looked up and answered in the control plane.
 *
 * Authenticated as the rest of the page is: the console grant, replaced once
 * when refused. A gateway without computers (501, 404) reads as `notYours`,
 * and the page then shows nothing about them.
 */

import { asksOf, handleLabel, machineAppUrl, machineCallOf, machinesPageOf, type MachineRoute } from "./texMachineGateway";
import type { MachinesPage, Pairing } from "./texMachineTypes";
import type { Read, TexPageSource } from "./texPageSource";
import type { Overview } from "./texPageTypes";

type Rec = Record<string, unknown>;

/** The control plane's half of pairing: look a code up (once; each look costs an attempt) and answer it. */
export interface PairingCalls {
  find(code: string): Promise<{ name: string; os: string; createdAt: number } | null>;
  answer(code: string, approve: boolean): Promise<boolean>;
}

export interface MachineSourceOptions {
  endpoint: string;
  workspaceId: string;
  token: (refresh: boolean | { rejected: string }) => Promise<string>;
  /** The code the address carried (`?code=`), if any. */
  pairingCode: () => string | null;
  pairing: PairingCalls;
  /** The person's own handle, left out of a chat's people: "Only you" already names them. */
  selfHandle?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const OS_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

export function withGatewayMachines(base: TexPageSource, options: MachineSourceOptions): TexPageSource {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? (() => Date.now());
  let listed: Rec[] = [];
  let groupChats: { key: string; name: string }[] = [];
  // One look per code: the control plane counts every look as an attempt.
  const looked = new Map<string, Pairing | null>();
  const answered = new Set<string>();
  // A group chat's people with their ids, read once per chat while the page is open.
  const people = new Map<string, { userId: string; handle: string }[]>();
  const GROUP_KEY = /^[0-9a-f]{64}$/;

  const post = async (route: MachineRoute, body: Rec): Promise<{ status: number; body: unknown } | null> => {
    const url = machineAppUrl(options.endpoint, route);
    if (url === null) return null;
    const call = async (refresh: boolean | { rejected: string }) => {
      const token = await options.token(refresh);
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: options.workspaceId, ...body }),
      });
      return { token, status: response.status, body: await response.json().catch(() => null) };
    };
    try {
      let answer = await call(false);
      if (answer.status === 401) answer = await call({ rejected: answer.token });
      return answer;
    } catch {
      return null;
    }
  };

  const list = async (): Promise<Read<Rec[]>> => {
    const a = await post("list", {});
    if (a === null) return { kind: "failed" };
    if (a.status === 404 || a.status === 501) return { kind: "notYours" };
    const body = a.body as { ok?: unknown; machines?: unknown } | null;
    if (a.status !== 200 || body?.ok !== true || !Array.isArray(body.machines)) return { kind: "failed" };
    listed = body.machines.filter((m): m is Rec => m !== null && typeof m === "object");
    return { kind: "ok", value: listed };
  };

  const peopleOf = async (chat: string): Promise<void> => {
    if (!GROUP_KEY.test(chat) || people.has(chat)) return;
    const a = await post("chat-people", { chat });
    const body = a?.body as { ok?: unknown; people?: unknown } | null | undefined;
    if (a?.status !== 200 || body?.ok !== true || !Array.isArray(body.people)) return;
    people.set(
      chat,
      body.people
        .filter((p): p is { userId: string; handle: string } => typeof (p as Rec)?.userId === "string" && typeof (p as Rec)?.handle === "string" && (p as Rec).handle !== "")
        .map((p) => ({ userId: p.userId, handle: p.handle })),
    );
  };

  /** The groups whose people the page needs: this chat, and any whose rule names people. */
  const groupsNeeded = (chat: string): string[] => {
    const named = new Set<string>();
    for (const m of listed) {
      for (const [rule, value] of Object.entries((m.chats as Rec | undefined) ?? {})) {
        if (!rule.startsWith("group-") || !Array.isArray((value as Rec | null)?.who)) continue;
        const key = groupChats.find((c) => c.key.slice(0, 58) === rule.slice("group-".length))?.key;
        if (key) named.add(key);
      }
    }
    if (GROUP_KEY.test(chat)) named.add(chat);
    return [...named].slice(0, 10);
  };

  const pairingNow = async (): Promise<Pairing | null> => {
    const code = options.pairingCode();
    if (code === null || answered.has(code)) return null;
    if (!looked.has(code)) {
      const found = await options.pairing.find(code).catch(() => null);
      looked.set(code, found ? { code, name: found.name, os: OS_LABEL[found.os] ?? found.os, tools: [], at: found.createdAt } : null);
    }
    return looked.get(code) ?? null;
  };

  return {
    ...base,
    async overview(chat, part) {
      // The machines' asks go on the person's own first screen: read beside the page, never after it.
      const wantsAsks = chat === "me" && (part === undefined || part === "core");
      const [read, machines] = await Promise.all([base.overview(chat, part), wantsAsks ? list() : null]);
      if (read.kind !== "ok") return read;
      if (part !== "tiles") groupChats = read.value.chats.filter((c) => c.key !== "me").map((c) => ({ key: c.key, name: c.name }));
      if (machines === null || machines.kind !== "ok") return read;
      const asks = asksOf(machines.value);
      const o: Overview = { ...read.value, asks, status: { ...read.value.status, needsYou: read.value.status.needsYou + asks.length } };
      return { kind: "ok", value: o };
    },
    async machines(chat) {
      const [machines, pairing] = await Promise.all([list(), pairingNow()]);
      if (machines.kind !== "ok") return machines;
      await Promise.all(groupsNeeded(chat).map(peopleOf));
      const here = (people.get(chat) ?? []).filter((p) => p.handle !== options.selfHandle).map((p) => handleLabel(p.handle));
      const page = machinesPageOf({ ok: true, machines: machines.value }, { now: now(), groupChats, pairing, people });
      if (page && here.length) page.chatPeople = here;
      return page ? ({ kind: "ok", value: page } as Read<MachinesPage>) : { kind: "failed" };
    },
    async act(chat, action) {
      if (!action.type.startsWith("machine.") && action.type !== "job.allow") return base.act(chat, action);
      if (action.type === "machine.chat" && Array.isArray(action.values.who)) await peopleOf(action.chat);
      const call = machineCallOf(action as Parameters<typeof machineCallOf>[0], (id) => listed.find((m) => m.id === id) ?? null, people);
      if ("refused" in call) return { ok: false, error: call.refused };
      if ("pair" in call) {
        const ok = await options.pairing.answer(call.pair.code, call.pair.approve).catch(() => false);
        if (ok) answered.add(call.pair.code);
        return ok ? { ok: true } : { ok: false, error: "pairing_failed" };
      }
      const a = await post(call.route, call.body);
      if (a === null) return { ok: false, error: "unreachable" };
      const body = a.body as { ok?: unknown; code?: unknown; error?: unknown } | null;
      if (a.status === 200 && body?.ok === true) return { ok: true };
      const error = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : `status_${a.status}`;
      return { ok: false, error };
    },
  };
}
