/**
 * One access topic from the objects, for a screen that also has the Convex
 * query for it (`objectAccess.ts`). Every screen asking the same side of the
 * same workspace shares one socket, which subscribes to the union of their
 * topics and closes when the last one leaves.
 *
 *   const object = useObjectAccess("workspace", workspaceId, "members");
 *   const convex = useQuery(api.functions.workspaces.listMembers, object.served ? "skip" : { workspaceId });
 *   const members = object.served ? object.rows : convex;
 *
 * `served` is false until the object sends the topic's rows, and again whenever
 * it stops (not switched yet, socket down), so the Convex query runs exactly
 * while the object does not answer.
 */

import { useCallback, useEffect, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { gatewayOriginFrom } from "../meetings/gateway";
import { AccessRefusal, openObjectAccess, type AccessSide, type ObjectAccess } from "./objectAccess";

type Listener = (rows: unknown | undefined) => void;

interface Shared {
  access: ObjectAccess;
  listeners: Map<string, Set<Listener>>;
  latest: Map<string, unknown>;
}

const sockets = new Map<string, Shared>();

type Mint = ReturnType<typeof useConsoleGrant>;
/** Each grant minter (one per signed-in account and app instance) gets its own sockets: an account switch never reuses one. */
const minters = new WeakMap<Mint, number>();
let mintersSeen = 0;
function minterId(mint: Mint): number {
  let id = minters.get(mint);
  if (id === undefined) {
    mintersSeen += 1;
    id = mintersSeen;
    minters.set(mint, id);
  }
  return id;
}

function join(key: string, side: AccessSide, workspaceId: Id<"workspaces">, origin: string, mint: Mint, topic: string, listener: Listener): () => void {
  let shared = sockets.get(key);
  if (shared === undefined) {
    const listeners = new Map<string, Set<Listener>>();
    const latest = new Map<string, unknown>();
    const access = openObjectAccess({
      gatewayOrigin: origin,
      side,
      token: async (refresh) => (await mint({ workspaceId }, refresh)).accessToken,
      onTopic: (name, rows) => {
        if (rows === undefined) latest.delete(name);
        else latest.set(name, rows);
        for (const held of listeners.get(name) ?? []) held(rows);
      },
    });
    shared = { access, listeners, latest };
    sockets.set(key, shared);
  }
  const { listeners, latest, access } = shared;
  const held = listeners.get(topic) ?? new Set<Listener>();
  held.add(listener);
  listeners.set(topic, held);
  access.subscribe([...listeners.keys()]);
  if (latest.has(topic)) listener(latest.get(topic));
  return () => {
    held.delete(listener);
    if (held.size === 0) listeners.delete(topic);
    if (listeners.size > 0) return access.subscribe([...listeners.keys()]);
    access.close();
    sockets.delete(key);
  };
}

export interface ObjectTopic<T> {
  /** Whether the object answers this topic now; when false, read Convex. */
  served: boolean;
  rows: T | undefined;
  /** One write through the object; rejects with `AccessRefusal("not_served")` when the caller should ask Convex. */
  run: (op: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function useObjectAccess<T = unknown>(side: AccessSide, workspaceId: Id<"workspaces"> | null | undefined, topic: string): ObjectTopic<T> {
  const mint = useConsoleGrant();
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  const [rows, setRows] = useState<T | undefined>(undefined);
  const key = workspaceId && origin ? `${minterId(mint)}:${side}:${workspaceId}` : null;

  useEffect(() => {
    setRows(undefined);
    if (key === null || !workspaceId || origin === null) return;
    return join(key, side, workspaceId, origin, mint, topic, (next) => setRows(next as T | undefined));
  }, [key, side, workspaceId, origin, mint, topic]);

  const run = useCallback(
    (op: string, args?: Record<string, unknown>) => {
      const shared = key === null ? undefined : sockets.get(key);
      return shared === undefined ? Promise.reject(new AccessRefusal("not_served")) : shared.access.run(op, args);
    },
    [key],
  );
  return { served: rows !== undefined, rows, run };
}

/**
 * A write through the object when it serves `topic`, else the Convex call. A
 * refusal other than `not_served` is the object's answer and is thrown as is.
 */
export async function objectFirst<R>(object: ObjectTopic<unknown>, op: string, args: Record<string, unknown>, convex: () => Promise<R>): Promise<R | unknown> {
  if (!object.served) return convex();
  try {
    return await object.run(op, args);
  } catch (error) {
    if (error instanceof AccessRefusal && error.code === "not_served") return convex();
    throw error;
  }
}

/** For tests: drop every shared socket. */
export function resetObjectAccessForTests() {
  for (const shared of sockets.values()) shared.access.close();
  sockets.clear();
}
