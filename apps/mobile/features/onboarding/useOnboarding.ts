/**
 * The first run, wired to the control plane.
 *
 * Every rule worth arguing about lives in the pure modules beside this file —
 * `route.ts`, `name.ts`, `structure.ts`, `flow.ts`, `verify.ts`. This holds the
 * subscriptions, the mutations, and the `useState` calls, and as little
 * judgement as possible.
 *
 * ## The one part that talks to a backend that is still landing
 *
 * Laying a starting layout into a freshly-connected bucket needs a callable
 * that is being built in parallel. It is looked up **by name at runtime**,
 * exactly as `useIngestionSettings` does for `functions/ingestion`: a
 * deployment without it reports `available: false` and the step says the
 * folders can be made in the console, instead of throwing on a missing
 * function reference. The same goes for `scaffoldReason` on the storage
 * binding — an older backend simply does not send it, and `structureStepFor`
 * treats that as "ask".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAction,
  useConvex,
  useMutation,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toBindStorageArgs, type ConnectFormValues, type Provider } from "../console/storage/connect";
import { describeCreateFailure, describeStructureFailure, type CreateFailure } from "./errors";
import { afterStorage, type FlowShape, type StepKey } from "./flow";
import { canClaim, nameStatus, normalizedName, shouldCheckAvailability, type NameAvailability, type NameStatus } from "./name";
import {
  emptyCustomFolders,
  structureStepFor,
  toApplyStructureArgs,
  validateCustomFolders,
  type CustomFolderRow,
  type FolderErrors,
  type StructureStep,
  type StructureTemplate,
} from "./structure";
import {
  CONNECT_TIMEOUT_MS,
  connectProgress,
  type ConnectState,
  type WatchedBinding,
} from "./verify";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRef = FunctionReference<any, any, any, any>;

/**
 * The callable that lays a layout into an empty bucket.
 *
 * Searched for by name across the deployment's modules rather than pinned to
 * one, because it is being added in parallel and its home is not settled. A
 * miss is a supported state, not an error.
 */
const APPLY_STRUCTURE_NAMES = [
  "applyStructure",
  "applyStructureTemplate",
  "applyLayout",
  "scaffoldStructure",
];

function findApplyStructure(): AnyRef | undefined {
  const modules = api.functions as unknown as Record<
    string,
    Record<string, AnyRef | undefined> | undefined
  >;
  for (const module of Object.values(modules)) {
    if (module === undefined || module === null) continue;
    for (const name of APPLY_STRUCTURE_NAMES) {
      const ref = module[name];
      if (ref !== undefined) return ref;
    }
  }
  return undefined;
}

/** Convex hands back `undefined` while loading and an `Error` when a query throws. */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export interface ClaimedContext {
  workspaceId: Id<"workspaces">;
  slug: string;
}

export interface OnboardingController {
  step: StepKey;
  shape: FlowShape;
  /** `undefined` until `listMyWorkspaces` resolves. Never read as zero. */
  contextCount: number | undefined;
  claimed: ClaimedContext | null;

  // ── Step 1 ────────────────────────────────────────────────────────────────
  name: string;
  setName: (value: string) => void;
  nameStatus: NameStatus;
  claiming: boolean;
  claimFailure: CreateFailure | null;
  claim: () => Promise<void>;
  canClaim: boolean;

  // ── Step 2 ────────────────────────────────────────────────────────────────
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  connectState: ConnectState;
  skipStorage: () => void;
  /** Move on with a binding that failed or timed out. */
  continuePastStorage: () => void;

  // ── Step 3 ────────────────────────────────────────────────────────────────
  structureStep: StructureStep;
  template: StructureTemplate;
  setTemplate: (value: StructureTemplate) => void;
  folders: CustomFolderRow[];
  setFolders: (rows: CustomFolderRow[]) => void;
  folderErrors: FolderErrors;
  applying: boolean;
  structureFailure: CreateFailure | null;
  /** False when this deployment has no callable for it yet. */
  structureAvailable: boolean;
  applyStructure: () => Promise<void>;
  skipStructure: () => void;
}

export function useOnboarding(): OnboardingController {
  const convex = useConvex();

  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces) as
    | Array<{ workspaceId: Id<"workspaces">; slug: string }>
    | undefined;

  const [step, setStep] = useState<StepKey>("name");
  const [claimed, setClaimed] = useState<ClaimedContext | null>(null);
  const [storageSkipped, setStorageSkipped] = useState(false);

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  const [name, setNameRaw] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimFailure, setClaimFailure] = useState<CreateFailure | null>(null);
  const createWorkspace = useMutation(api.functions.workspaces.createWorkspace);

  const normalized = normalizedName(name);

  // Keyed on the normalized name, so an answer for a name that is no longer in
  // the field can never be applied to the one that is.
  const availabilitySpec = useMemo<RequestForQueries>(() => {
    const empty: RequestForQueries = {};
    if (!shouldCheckAvailability(name)) return empty;
    return {
      availability: {
        query: api.functions.names.checkNameAvailable,
        args: { name: normalized },
      },
    };
    // `normalized` is derived from `name`; both are listed so the intent is
    // visible at the call site.
  }, [name, normalized]);

  const availabilityResults = useQueries(availabilitySpec);
  const availability = usable<NameAvailability>(availabilityResults.availability);
  const status = nameStatus(name, availability);

  const setName = useCallback((value: string) => {
    setNameRaw(value);
    setClaimFailure(null);
  }, []);

  const claim = useCallback(async () => {
    // Narrowed rather than merely checked: only an `available` status carries a
    // normalized name, and it is the only one that may be claimed.
    if (status.kind !== "available" || claiming) return;
    setClaiming(true);
    setClaimFailure(null);
    try {
      const result = await createWorkspace({
        slug: status.normalized,
        // Onboarding does not ask for a separate label — one field is the
        // point. The name is a perfectly good display name, and the console
        // renames it without touching the claim.
        displayName: status.normalized,
        kind: "personal",
        // The layout is chosen after the bucket is scanned, so nothing is
        // decided here. See the note in `WelcomeScreen`.
        structureTemplate: "custom",
      });
      setClaimed({ workspaceId: result.workspaceId, slug: result.slug });
      setStep("storage");
    } catch (error) {
      setClaimFailure(describeCreateFailure(error));
    } finally {
      setClaiming(false);
    }
  }, [claiming, createWorkspace, status]);

  // ── Step 2 ──────────────────────────────────────────────────────────────────
  const bindStorage = useAction(api.functions.storage.bindStorage);
  const [submitted, setSubmitted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const bindingSpec = useMemo<RequestForQueries>(() => {
    const empty: RequestForQueries = {};
    if (claimed === null) return empty;
    return {
      binding: {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: claimed.workspaceId },
      },
    };
  }, [claimed]);

  const bindingResults = useQueries(bindingSpec);
  const rawBinding = bindingResults.binding;
  const binding =
    rawBinding === undefined || rawBinding instanceof Error
      ? undefined
      : (rawBinding as (WatchedBinding & { scaffoldReason?: string }) | null);

  const connectState = connectProgress({ submitted, binding, timedOut });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const connect = useCallback(
    async (values: ConnectFormValues) => {
      if (claimed === null) throw new Error("No context to connect a bucket to.");
      setSubmitted(true);
      setTimedOut(false);
      clearTimer();
      timer.current = setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
      try {
        const args = toBindStorageArgs(values, claimed.workspaceId);
        const result = await bindStorage({
          ...args,
          workspaceId: claimed.workspaceId,
          provider: args.provider as Provider,
        });
        return { status: result.status };
      } catch (error) {
        // The form owns the failure display for a *rejected* bind (a bad
        // endpoint, an ambiguous address). Reset so its own error panel is the
        // one on screen rather than a second one underneath it.
        clearTimer();
        setSubmitted(false);
        throw error;
      }
    },
    [bindStorage, claimed, clearTimer],
  );

  /**
   * The probe landing is what moves the flow on — not the action returning.
   *
   * `bindStorage` resolves as soon as the row is written, while the bucket is
   * still `unverified`. Advancing there would show somebody a layout step for a
   * bucket that turns out to be unreachable.
   */
  useEffect(() => {
    if (step !== "storage") return;
    if (connectState.kind !== "connected") return;
    clearTimer();
    setStep(afterStorage("connected"));
  }, [clearTimer, connectState.kind, step]);

  const skipStorage = useCallback(() => {
    setStorageSkipped(true);
    setStep(afterStorage("skipped"));
  }, []);

  const continuePastStorage = useCallback(() => {
    setStep(afterStorage("connected"));
  }, []);

  // ── Step 3 ──────────────────────────────────────────────────────────────────
  const structureStep = structureStepFor(binding?.scaffoldReason);
  const [template, setTemplate] = useState<StructureTemplate>("para");
  const [folders, setFolders] = useState<CustomFolderRow[]>(emptyCustomFolders());
  const [applying, setApplying] = useState(false);
  const [structureFailure, setStructureFailure] = useState<CreateFailure | null>(null);
  const applyRef = useMemo(() => findApplyStructure(), []);

  const folderErrors = validateCustomFolders(folders);

  const skipStructure = useCallback(() => setStep("done"), []);

  const applyStructure = useCallback(async () => {
    if (claimed === null || applying) return;
    if (applyRef === undefined) {
      setStep("done");
      return;
    }
    setApplying(true);
    setStructureFailure(null);
    try {
      await convex.action(
        applyRef,
        toApplyStructureArgs(claimed.workspaceId, template, folders) as never,
      );
      setStep("done");
    } catch (error) {
      setStructureFailure(describeStructureFailure(error));
    } finally {
      setApplying(false);
    }
  }, [applyRef, applying, claimed, convex, folders, template]);

  return {
    step,
    shape: { storageSkipped },
    contextCount: workspaces === undefined ? undefined : workspaces.length,
    claimed,

    name,
    setName,
    nameStatus: status,
    claiming,
    claimFailure,
    claim,
    canClaim: canClaim(status) && !claiming,

    connect,
    connectState,
    skipStorage,
    continuePastStorage,

    structureStep,
    template,
    setTemplate,
    folders,
    setFolders,
    folderErrors,
    applying,
    structureFailure,
    structureAvailable: applyRef !== undefined,
    applyStructure,
    skipStructure,
  };
}
