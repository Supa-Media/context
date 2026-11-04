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

import { asksOf, machineAppUrl, machineCallOf, machinesPageOf, type MachineRoute } from "./texMachineGateway";
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
    async overview(chat) {
      const read = await base.overview(chat);
      if (read.kind !== "ok") return read;
      groupChats = read.value.chats.filter((c) => c.key !== "me").map((c) => ({ key: c.key, name: c.name }));
      if (chat !== "me") return read;
      const machines = await list();
      if (machines.kind !== "ok") return read;
      const asks = asksOf(machines.value);
      const o: Overview = { ...read.value, asks, status: { ...read.value.status, needsYou: read.value.status.needsYou + asks.length } };
      return { kind: "ok", value: o };
    },
    async machines() {
      const [machines, pairing] = await Promise.all([list(), pairingNow()]);
      if (machines.kind !== "ok") return machines;
      const page = machinesPageOf({ ok: true, machines: machines.value }, { now: now(), groupChats, pairing });
      return page ? ({ kind: "ok", value: page } as Read<MachinesPage>) : { kind: "failed" };
    },
    async act(chat, action) {
      if (!action.type.startsWith("machine.") && action.type !== "job.allow") return base.act(chat, action);
      const call = machineCallOf(action as Parameters<typeof machineCallOf>[0], (id) => listed.find((m) => m.id === id) ?? null);
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
