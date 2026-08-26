/**
 * The first run, wired to the control plane.
 *
 * Every rule worth arguing about lives in the pure modules beside this file —
 * `route.ts`, `name.ts`, `structure.ts`, `flow.ts`, `verify.ts`. This holds the
 * subscriptions, the mutations, and the `useState` calls, and as little
 * judgement as possible.
 *
 * ## The one call pinned by hand
 *
 * `applyStructure` is named as a string rather than reached through the
 * generated `api`, because the mutation lands in a parallel branch (#21) and
 * this branch's `_generated/api.d.ts` does not know about it yet.
 *
 * It is a **pinned name**, not a search. There was a `findApplyStructure()`
 * here that walked `Object.values(api.functions)` looking for a callable with
 * one of several plausible names, so that a deployment without it could report
 * `structureAvailable: false`. It could never report anything else. `api` is
 * `anyApi` — a `Proxy` with a `get` trap and nothing else, no `ownKeys`, no
 * `getOwnPropertyDescriptor` — so enumeration falls through to the empty target
 * and `Object.values(api.functions)` is `[]` on every deployment that has ever
 * existed. The lookup returned `undefined` every single time, and the "Create
 * these" button silently advanced to the last screen without writing anything.
 * A probe whose negative answer is the only answer it can give is not a probe;
 * this is the same shape of bug as issue #16.
 *
 * So there is no probe now. The name is pinned, the call is made, and a
 * deployment that does not have it fails the way any other missing function
 * fails — loudly, into `describeStructureFailure`, which is already written to
 * say that the context and the bucket are fine and folders can be made in the
 * console. When #21 lands, this becomes `api.functions.workspaces.applyStructure`
 * and the type declaration below goes away.
 *
 * `scaffoldReason` on the storage binding is the other half-landed field, and
 * that one genuinely is optional: an older backend does not send it, and
 * `structureStepFor` treats absence as "ask".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQueries, useQuery, type RequestForQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import { toBindStorageArgs, type ConnectFormValues, type Provider } from "../console/storage/connect";
import { describeCreateFailure, describeStructureFailure, type CreateFailure } from "./errors";
import { afterStorage, type FlowShape, type StepKey, type StorageOutcome } from "./flow";
import { canClaim, nameStatus, normalizedName, shouldCheckAvailability, type NameAvailability, type NameStatus } from "./name";
import {
  canApplyStructure,
  emptyCustomFolders,
  structureStepFor,
  toApplyStructureArgs,
  validateCustomFolders,
  type CustomFolderRow,
  type FolderErrors,
  type StructureFolderSpec,
  type StructureStep,
  type StructureTemplate,
} from "./structure";
import {
  CONNECT_TIMEOUT_MS,
  connectProgress,
  type ConnectState,
  type WatchedBinding,
} from "./verify";

/**
 * `functions/workspaces:applyStructure`, by name.
 *
 * Hand-declared only because the generated types for it live on an unmerged
 * branch. The argument shape is copied from that mutation's validator: the
 * template field is `template` (`structureTemplate` is the column it writes,
 * not the argument it takes), and `folders` is required for `custom` and
 * refused for `para`.
 */
export const APPLY_STRUCTURE = "functions/workspaces:applyStructure";

const applyStructureRef = makeFunctionReference<
  "mutation",
  {
    workspaceId: Id<"workspaces">;
    template: StructureTemplate;
    folders?: StructureFolderSpec[];
  },
  { queued: boolean; template: string; folders: string[] }
>(APPLY_STRUCTURE);

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
  /**
   * Move on with a binding that failed or timed out.
   *
   * Not the same as connecting one. See `StorageOutcome`: this ends the run in
   * `unverified`, which skips the layout step and warns on the way out.
   */
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
  /** False while there is nothing this button could legally send. */
  canApply: boolean;
  applyStructure: () => Promise<void>;
  skipStructure: () => void;
}

export function useOnboarding(): OnboardingController {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces) as
    | Array<{ workspaceId: Id<"workspaces">; slug: string }>
    | undefined;

  const [step, setStep] = useState<StepKey>("name");
  const [claimed, setClaimed] = useState<ClaimedContext | null>(null);
  // Starts at `connected` because that is the run the step rail should draw
  // before anything has gone wrong: the full four steps. It is only ever
  // narrowed, by an explicit choice on the storage step, and every path off
  // that step sets it.
  const [storage, setStorage] = useState<StorageOutcome>("connected");

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  const [name, setNameRaw] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimFailure, setClaimFailure] = useState<CreateFailure | null>(null);
  const createWorkspace = useMutation(api.functions.workspaces.createWorkspace);

  const normalized = normalizedName(name);

  // Keyed on the normalized name, so an answer for a name that is no longer in
  // the field can never be applied to the one that is.
  const availabilitySpec = useMemo<RequestForQueries>(() => {
    // The shared frozen object, not a fresh `{}`. See `console/querySpec.ts`:
    // a new identity makes `useSubscription` set state during render and tear
    // the observer down and back up — once per keystroke, here.
    if (!shouldCheckAvailability(name)) return EMPTY_QUERY_SPEC;
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
        // `structureTemplate` is deliberately **not** sent.
        //
        // It used to be sent as `"custom"`, under a comment saying nothing was
        // decided here. Passing a value *is* the decision — it is the field the
        // scaffolder reads — and it was made two screens before the person was
        // shown the choice, then told they would get five PARA folders. They
        // would have got none. The argument is optional; the layout travels
        // with `applyStructure`, which overwrites this column with what was
        // actually picked.
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
    // Shared and frozen, for `console/querySpec.ts`'s reason.
    if (claimed === null) return EMPTY_QUERY_SPEC;
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
    setStorage("skipped");
    setStep(afterStorage("skipped"));
  }, []);

  /**
   * "Carry on anyway", after a probe that failed or never answered.
   *
   * This is emphatically **not** `connected`. The button only exists in those
   * two states, and in both of them nobody has looked inside the bucket: it
   * could be empty, or it could be a vault somebody has been writing to for
   * years. Recording it as connected — which is what this used to do — handed
   * the person the layout step, which opens with "Your bucket is empty, so here
   * is a starting shape", and left the last screen with no warning on it at all.
   */
  const continuePastStorage = useCallback(() => {
    setStorage("unverified");
    setStep(afterStorage("unverified"));
  }, []);

  // ── Step 3 ──────────────────────────────────────────────────────────────────
  const structureStep = structureStepFor(binding?.scaffoldReason);
  const [template, setTemplate] = useState<StructureTemplate>("para");
  const [folders, setFolders] = useState<CustomFolderRow[]>(emptyCustomFolders());
  const [applying, setApplying] = useState(false);
  const [structureFailure, setStructureFailure] = useState<CreateFailure | null>(null);
  const applyStructureMutation = useMutation(applyStructureRef);

  const folderErrors = validateCustomFolders(folders);

  const skipStructure = useCallback(() => setStep("done"), []);

  const applyStructure = useCallback(async () => {
    if (claimed === null || applying) return;
    if (!canApplyStructure(template, folders, folderErrors)) return;
    setApplying(true);
    setStructureFailure(null);
    try {
      // The chosen template and the folders typed on this screen, sent as they
      // were chosen and typed. There is no other path out of the editor.
      const args = toApplyStructureArgs(claimed.workspaceId, template, folders);
      await applyStructureMutation({ ...args, workspaceId: claimed.workspaceId });
      setStep("done");
    } catch (error) {
      setStructureFailure(describeStructureFailure(error));
    } finally {
      setApplying(false);
    }
  }, [applyStructureMutation, applying, claimed, folderErrors, folders, template]);

  return {
    step,
    shape: { storage },
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
    canApply: canApplyStructure(template, folders, folderErrors) && !applying,
    applyStructure,
    skipStructure,
  };
}
