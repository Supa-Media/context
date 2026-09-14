import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import { PluginSandboxFarm } from "./PluginSandboxFarm";
import { newSandboxNonce } from "./sandboxNonce";
import type { ActiveFileRef, SandboxEvent, VaultEventMessage } from "./sandboxTypes";
import type { PluginGrant } from "./grants";
import { vaultEventForOperation } from "./runtime";
import type { ActiveSandbox, RuntimeState, RuntimeView } from "./runtime";

/**
 * What the sandbox host says each plugin is doing.
 *
 * A live subscription, like `useGrants` and unlike `usePlugins`: these are rows
 * the control plane already holds, written by `reportRuntimeStatus` after a load
 * or a bounded crash retry. It has to be live — a plugin that crash-loops while
 * somebody is looking at this screen should say so without being asked, and a
 * Revoke pressed one card away turns its runtime row to `blocked` in the same
 * transaction.
 *
 * Owner-only, decided from `role` before the call, like every other plugin view.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useRuntime(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
  /**
   * The note the console has open, or `null`.
   *
   * Passed down to every loaded sandbox so `workspace.getActiveFile()` answers
   * and `file-open` fires. Path and etag only — a plugin that wants the body
   * reads it through the audited RPC like any other file.
   */
  activeFile?: ActiveFileRef | null;
  /**
   * What each plugin was approved for.
   *
   * Required for the host to know who may be told a note's path at all — see
   * `maySeePaths`. Absent (the query has not answered) means nobody is told
   * anything, which is the right way round: a plugin that hears about a change
   * a moment late is a plugin working; one told a path it was never granted is
   * a read nobody approved.
   */
  grants?: readonly PluginGrant[];
}): RuntimeView {
  const { workspaceId, role, activeFile = null, grants } = options;
  const isOwner = role === "owner";
  const loadBundle = useAction(api.functions.obsidianPlugins.loadPluginBundle);
  const executeRequest = useAction(api.functions.obsidianPlugins.executePluginRequest);
  const reportStatus = useMutation(api.functions.obsidianPlugins.reportRuntimeStatus);
  const stopPlugin = useMutation(api.functions.obsidianPlugins.stopPlugin);
  const [sandboxes, setSandboxes] = useState<ActiveSandbox[]>([]);
  const resumed = useRef(new Set<string>());
  /*
    The last change Context made, handed to every loaded guest.

    **Only what Context did.** A write from Obsidian or rclone never passes
    through this console, so it is not here and no plugin is told about it — the
    limit the product took on 2026-09-14, and the reason the consent screen says
    so out loud rather than leaving somebody to find out from a stale panel.

    One slot rather than a queue: a guest is sent the message as soon as the
    number changes, and two writes in the same frame are two renders.
  */
  const [vaultEvent, setVaultEvent] = useState<VaultEventMessage | undefined>(undefined);
  const seq = useRef(0);
  const publish = useCallback((event: Omit<VaultEventMessage, "seq">) => {
    seq.current += 1;
    setVaultEvent({ ...event, seq: seq.current });
  }, []);

  /*
    A save in the console's own editor, derived rather than reported.

    `useFileBrowser` does not call anybody back on save, and threading a
    callback through it to reach here would be a large change to the editor for
    a small one here. It does not need to: a save is exactly "the same path came
    back with a different etag", which is visible from the two fields already
    handed down. A path *change* is somebody opening another note and is not a
    write.
  */
  const lastSeen = useRef<{ path: string; etag: string | null } | null>(null);
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = activeFile === null
      ? null
      : { path: activeFile.path, etag: activeFile.etag };
    if (activeFile === null || previous === null) return;
    if (previous.path !== activeFile.path) return;
    if (previous.etag === activeFile.etag) return;
    if (previous.etag === null) return;
    publish({ kind: "modify", path: activeFile.path, etag: activeFile.etag });
  }, [activeFile, publish]);

  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return {
      states: { query: api.functions.obsidianPlugins.listRuntimeStates, args: { workspaceId } },
    };
  }, [workspaceId, isOwner]);

  const results = useQueries(spec);
  const raw = results.states;
  /*
    `undefined` in flight, `Error` when the query threw — `useQueries`, never
    `useQuery`, so one failing subscription does not take the console down.
    Both leave `states` absent rather than empty: an empty array is the claim
    that nothing is running, which is a different sentence from not knowing.
  */
  const states = raw === undefined || raw instanceof Error ? undefined : (raw as RuntimeState[]);

  const reportCrash = useCallback(async (
    pluginId: string,
    bundleFingerprint: string,
    attempts: number,
    error: unknown,
  ) => {
    if (workspaceId === null) return;
    const message = error instanceof Error ? error.message : String(error);
    await reportStatus({
      workspaceId,
      pluginId,
      bundleFingerprint,
      status: "crash-looped",
      attempts,
      errorCode: "PLUGIN_LOAD_FAILED",
      errorMessage: message.slice(0, 500),
    }).catch(() => undefined);
  }, [reportStatus, workspaceId]);

  const start = useCallback(async (pluginId: string, bundleFingerprint: string) => {
    if (workspaceId === null || !isOwner) return;
    resumed.current.add(`${workspaceId}:${pluginId}:${bundleFingerprint}`);
    setSandboxes((was) => was.filter((one) => one.bundle.pluginId !== pluginId));
    let lastError: unknown = new Error("Plugin did not start");
    for (let attempts = 1; attempts <= 3; attempts += 1) {
      try {
        const bundle = await loadBundle({ workspaceId, pluginId, bundleFingerprint });
        setSandboxes((was) => [
          ...was.filter((one) => one.bundle.pluginId !== pluginId),
          { bundle, nonce: newSandboxNonce(), attempts },
        ]);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await reportCrash(pluginId, bundleFingerprint, 3, lastError);
    throw lastError;
  }, [isOwner, loadBundle, reportCrash, workspaceId]);

  const stop = useCallback(async (pluginId: string, bundleFingerprint: string) => {
    if (workspaceId === null || !isOwner) return;
    // Remove the frame first. Its bearer token is deleted by the mutation next;
    // a racing final request is refused server-side even if unmount is delayed.
    resumed.current.add(`${workspaceId}:${pluginId}:${bundleFingerprint}`);
    setSandboxes((was) => was.filter((one) => one.bundle.pluginId !== pluginId));
    await stopPlugin({ workspaceId, pluginId, bundleFingerprint });
  }, [isOwner, stopPlugin, workspaceId]);

  const onEvent = useCallback((sandbox: ActiveSandbox, event: SandboxEvent) => {
    if (workspaceId === null) return;
    const { pluginId, bundleFingerprint, runtimeToken } = sandbox.bundle;
    if (event.type === "loaded") {
      void reportStatus({
        workspaceId, pluginId, bundleFingerprint,
        status: "loaded", attempts: sandbox.attempts,
      }).catch(() => undefined);
      return;
    }
    if (event.type === "rpc") {
      const requestId = typeof (event.request as { requestId?: unknown }).requestId === "string"
        ? (event.request as { requestId: string }).requestId
        : "invalid";
      const operation = (event.request as {
        operation?: { kind?: unknown; path?: unknown; from?: unknown; to?: unknown };
      }).operation;
      void executeRequest({ runtimeToken, request: event.request }).then((response) => {
        event.respond(response);
        const change = vaultEventForOperation(operation, response);
        if (change !== null) publish(change);
      }).catch(() => {
        event.respond({
          version: 1,
          requestId,
          ok: false,
          error: { code: "PLUGIN_SESSION_INVALID", message: "Start this plugin again" },
        });
      });
      return;
    }
    /*
      A FRAME THAT NAVIGATED AWAY IS STOPPED, NOT RETRIED.

      `crashed` below reloads up to three times, which is right for a bundle
      that threw and wrong for one that left: it would simply leave again on
      each attempt. So this ends the plugin and records `blocked` — the status
      whose own copy already says "Context turned this version off" — without
      touching the owner's approval, exactly as Stop does.
    */
    if (event.type === "disowned") {
      setSandboxes((was) => was.filter((one) => one.nonce !== sandbox.nonce));
      void reportStatus({
        workspaceId, pluginId, bundleFingerprint,
        status: "blocked", attempts: sandbox.attempts,
        errorCode: "SANDBOX_DISOWNED",
        errorMessage: "This plugin's sandbox stopped being the one Context started, so Context stopped it.",
      }).catch(() => undefined);
      return;
    }
    if (event.type === "crashed") {
      setSandboxes((was) => was.filter((one) => one.nonce !== sandbox.nonce));
      if (sandbox.attempts < 3) {
        void loadBundle({ workspaceId, pluginId, bundleFingerprint }).then((bundle) => {
          setSandboxes((was) => [
            ...was.filter((one) => one.bundle.pluginId !== pluginId),
            { bundle, nonce: newSandboxNonce(), attempts: sandbox.attempts + 1 },
          ]);
        }).catch((error) => reportCrash(pluginId, bundleFingerprint, 3, error));
      } else {
        void reportCrash(pluginId, bundleFingerprint, sandbox.attempts, new Error(event.message));
      }
    }
  }, [executeRequest, loadBundle, publish, reportCrash, reportStatus, workspaceId]);

  useEffect(() => {
    if (!states || workspaceId === null || !isOwner) return;
    for (const state of states) {
      if (state.status !== "loaded") continue;
      const key = `${workspaceId}:${state.pluginId}:${state.bundleFingerprint}`;
      if (resumed.current.has(key) || sandboxes.some((one) => one.bundle.pluginId === state.pluginId)) continue;
      resumed.current.add(key);
      void start(state.pluginId, state.bundleFingerprint).catch(() => undefined);
    }
  }, [isOwner, sandboxes, start, states, workspaceId]);

  // A revoke or Stop on another signed-in device invalidates every runtime
  // session server-side. Remove the now-authority-less local frame when the
  // live status row catches up; never leave third-party code running merely
  // because it can no longer reach the broker.
  useEffect(() => {
    if (!states) return;
    setSandboxes((was) => was.filter((sandbox) => states.some((state) =>
      state.status === "loaded" &&
      state.pluginId === sandbox.bundle.pluginId &&
      state.bundleFingerprint === sandbox.bundle.bundleFingerprint
    )));
  }, [states]);

  useEffect(() => {
    setSandboxes([]);
    resumed.current.clear();
  }, [workspaceId]);

  useEffect(() => {
    const timers = sandboxes.map((sandbox) => setTimeout(() => {
      void start(sandbox.bundle.pluginId, sandbox.bundle.bundleFingerprint).catch(() => undefined);
    }, Math.max(0, sandbox.bundle.expiresAt - Date.now() - 5_000)));
    return () => timers.forEach(clearTimeout);
  }, [sandboxes, start]);

  return {
    states,
    loading: isOwner && workspaceId !== null && raw === undefined,
    host: isOwner
      ? createElement(PluginSandboxFarm, { sandboxes, onEvent, activeFile, vaultEvent, grants })
      : undefined,
    actions: isOwner && workspaceId !== null ? { start, stop } : undefined,
  };
}
