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
 * console. #21 has landed, so the call now goes through the generated `api`
 * and the hand-declared argument shape is gone.
 *
 * `scaffoldReason` on the storage binding is the other half-landed field, and
 * that one genuinely is optional: an older backend does not send it, and
 * `structureStepFor` treats absence as "ask".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQueries, useQuery, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import { toBindStorageArgs, type ConnectFormValues, type Provider } from "../console/storage/connect";
import { describeCreateFailure, type CreateFailure } from "./errors";
import {
  afterDryRun,
  afterName,
  afterStorage,
  type FlowShape,
  type Next,
  type StepKey,
  type StorageOutcome,
  type StorageRoute,
} from "./flow";
import { dryRunReport, type DryRunBinding, type DryRunReport } from "./dryRun";
import type { ForkOffer } from "./redesign/ForkStep";
import { canClaim, nameStatus, normalizedName, shouldCheckAvailability, type NameAvailability, type NameStatus } from "./name";
import type { CheckoutOutcome } from "@context/shared";
import { ownedContexts } from "./route";
import { useManagedOffer, type ManagedOffer } from "./useManagedOffer";
import { structureStepFor, toApplyStructureArgs } from "./structure";
import {
  CONNECT_TIMEOUT_MS,
  connectProgress,
  type ConnectState,
  type WatchedBinding,
} from "./verify";

export const APPLY_STRUCTURE = "functions/workspaces:applyStructure";

/**
 * Convex hands back `undefined` while loading and an `Error` when a query
 * throws. Both mean "no answer yet" here.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

/** The standard folders being written after "Start fresh". */
export type LayoutProgress = "idle" | "writing" | "done";

/** How long the ticked folders stay on screen before the console. */
export const LAYOUT_SETTLE_MS = 900;

/** The most a layout that never reports back may hold the run. */
export const LAYOUT_WAIT_MS = 60_000;

export interface ClaimedContext {
  workspaceId: Id<"workspaces">;
  slug: string;
}

export interface OnboardingController {
  step: StepKey;
  shape: FlowShape;
  /** Personal contexts owned, or `undefined` while the list is outstanding. */
  owned: number | undefined;
  claimed: ClaimedContext | null;
  /**
   * True once the run is over and the person belongs in the console. The
   * screen navigates on it; nothing here does, so the controller stays a hook
   * with no router in it.
   */
  finished: boolean;

  // Step 1 — the handle
  name: string;
  setName: (value: string) => void;
  nameStatus: NameStatus;
  claiming: boolean;
  claimFailure: CreateFailure | null;
  claim: () => Promise<void>;
  canClaim: boolean;

  // Step 2 — the fork
  forkOffer: ForkOffer;
  /** "Start fresh": a bucket we run, then the standard folders, then the console. */
  pickManaged: () => void;
  /** "I already have notes": the point-at-your-bucket track. */
  pickOwn: () => void;
  startingFree: boolean;
  forkFailure?: string;

  // The storage track
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  connectState: ConnectState;
  managed: ManagedOffer | null;
  /** The standard folders after "Start fresh": being written, then written. */
  layout: LayoutProgress;
  /** "I'll do this later" — out to the console, whose setup widget asks again. */
  skipStorage: () => void;
  continuePastStorage: () => void;

  dryRun: DryRunReport | null;
  finishDryRun: () => void;
}

export function useOnboarding(
  options: {
    /**
     * Re-enter mid-run for a person who already owns their workspace.
     *
     * `fork` is the sign-in gate's (`resume.ts`): a name, and no storage.
     * `storage` is a return from Stripe, which lands on the settling screen.
     * `structure` is what an old Dropbox round trip still sends; the layout
     * choice moved to the console, so it re-enters by finishing.
     */
    resume?: "structure" | "storage" | "fork";
    /** What a return from Stripe said, from `/welcome?checkout=…`. */
    checkout?: CheckoutOutcome | null;
    /** Test seam for the settling copy's later wording. */
    settlingSlowAfter?: number;
    /** Test seam: how long the ticked folders stay before the console. */
    layoutSettleMs?: number;
  } = {},
): OnboardingController {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces) as
    | Array<{ workspaceId: Id<"workspaces">; slug: string; kind: string; role: string }>
    | undefined;

  const [step, setStep] = useState<StepKey>("name");
  const [finished, setFinished] = useState(false);
  const [claimed, setClaimed] = useState<ClaimedContext | null>(null);

  /** Move on: to a step, or out of the wizard altogether. */
  const go = useCallback((next: Next) => {
    if (next === "console") setFinished(true);
    else setStep(next);
  }, []);

  // Resume happens exactly once, when the owned workspace becomes known, and
  // only while the flow is still sitting on its first step — a person who has
  // moved on their own is never yanked back.
  const resumed = useRef(false);
  useEffect(() => {
    if (options.resume === undefined) return;
    if (resumed.current || claimed !== null) return;
    if (workspaces === undefined) return;
    const own = workspaces.find(
      (workspace) => workspace.kind === "personal" && workspace.role === "owner",
    );
    if (own === undefined) return;
    resumed.current = true;
    setClaimed({ workspaceId: own.workspaceId, slug: own.slug });
    go(options.resume === "structure" ? "console" : options.resume);
  }, [claimed, go, options.resume, workspaces]);

  const [route, setRoute] = useState<StorageRoute | undefined>(
    options.checkout ? "managed" : undefined,
  );

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  const [name, setNameRaw] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimFailure, setClaimFailure] = useState<CreateFailure | null>(null);
  const createWorkspace = useMutation(api.functions.workspaces.createWorkspace);

  const normalized = normalizedName(name);

  // Shared and frozen, for `console/querySpec.ts`'s reason.
  const availabilitySpec = useMemo<RequestForQueries>(() => {
    if (!shouldCheckAvailability(name)) return EMPTY_QUERY_SPEC;
    return {
      availability: {
        query: api.functions.names.checkNameAvailable,
        args: { name: normalized },
      },
    };
  }, [name, normalized]);

  const availabilityResults = useQueries(availabilitySpec);
  const availability = usable<NameAvailability>(availabilityResults.availability);
  const status = nameStatus(name, availability);

  const setName = useCallback((value: string) => {
    setNameRaw(value);
    setClaimFailure(null);
  }, []);

  const claim = useCallback(async () => {
    if (status.kind !== "available" || claiming) return;
    setClaiming(true);
    setClaimFailure(null);
    try {
      // No `structureTemplate`: the layout is decided by what the fork does
      // with the bucket (`applyStructure` below), never presumed at create.
      const result = await createWorkspace({
        slug: status.normalized,
        displayName: status.normalized,
        kind: "personal",
      });
      setClaimed({ workspaceId: result.workspaceId, slug: result.slug });
      go(afterName());
    } catch (error) {
      setClaimFailure(describeCreateFailure(error));
    } finally {
      setClaiming(false);
    }
  }, [claiming, createWorkspace, go, status]);

  // ── The storage track ───────────────────────────────────────────────────────
  const bindStorage = useAction(api.functions.storage.bindStorage);
  const [submitted, setSubmitted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const bindingSpec = useMemo<RequestForQueries>(() => {
    if (claimed === null) return EMPTY_QUERY_SPEC;
    return {
      binding: {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: claimed.workspaceId },
      },
    };
  }, [claimed]);

  const bindingResults = useQueries(bindingSpec);
  const binding = usable<(WatchedBinding & { scaffoldReason?: string }) | null>(
    bindingResults.binding,
  );

  const connectState = connectProgress({ submitted, binding, timedOut });

  const managed = useManagedOffer({
    workspaceId: claimed?.workspaceId ?? null,
    returned: options.checkout ?? null,
    slowAfter: options.settlingSlowAfter,
  });

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
      if (claimed === null) throw new Error("No workspace to connect a bucket to.");
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
        // The form owns the failure display for a *rejected* bind.
        clearTimer();
        setSubmitted(false);
        throw error;
      }
    },
    [bindStorage, claimed, clearTimer],
  );

  /*
    "Start fresh" means the canvas's promise: our bucket, *with* the standard
    five folders in it, and then the console. So once a bucket we made is
    verified, the standard layout is asked for here rather than on a screen of
    its own. Best-effort on purpose: a layout that fails to queue leaves an
    empty bucket, which the console already offers to lay out (`SetupPrompt`)
    — a failure here is never a reason to hold somebody out of their workspace.

    Never for a bucket somebody brought. The report comes first, and the
    console's own offer is the only thing that ever writes a layout into it.
  */
  const applyStructure = useMutation(api.functions.workspaces.applyStructure);
  const [layout, setLayout] = useState<LayoutProgress>("idle");
  // Once per run. A failed queue goes to the console rather than round again:
  // retrying here is how a refusal becomes a stream of mutations.
  const layoutAttempted = useRef(false);
  const layOutFreshBucket = useCallback(async () => {
    if (claimed === null || layoutAttempted.current) return;
    layoutAttempted.current = true;
    // `created` is a layout already written (a Stripe return can land after
    // it); `existing-context` is somebody's notes. Everything else on a bucket
    // we just made is empty — `features/console/setup.ts` has the vocabulary.
    const reason = binding?.scaffoldReason;
    if (reason === "created" || structureStepFor(reason).kind !== "ask") {
      go("console");
      return;
    }
    setLayout("writing");
    try {
      const args = toApplyStructureArgs(claimed.workspaceId, "para", []);
      await applyStructure({ ...args, workspaceId: claimed.workspaceId });
    } catch {
      // A layout that fails to queue: straight in. The console offers it.
      go("console");
    }
  }, [applyStructure, binding?.scaffoldReason, claimed, go]);

  /*
    HOLD THE RUN UNTIL THE FOLDERS ARE ACTUALLY THERE.

    Queuing the layout returns at once; writing it takes a few seconds. Going
    to the console in between put the first thing a new owner saw as a
    privacy warning about a `privacy.md` that was seconds from existing. So
    this step waits on the binding: the control plane clears
    `scaffoldQueuedAt` when the job reports back, and the verdict is in
    `scaffoldReason`. The five folders are drawn ticked for a moment, then
    the console — or, on a failure or a job that never answers within
    `LAYOUT_WAIT_MS`, the console anyway, whose band now says what is true.
  */
  const queuedAt = (binding as { scaffoldQueuedAt?: number } | null | undefined)?.scaffoldQueuedAt;
  // "No stamp" before the subscription has shown ours is not an answer: the
  // mutation can return before the binding it patched reaches this client.
  const sawQueued = useRef(false);
  if (layout === "writing" && typeof queuedAt === "number") sawQueued.current = true;
  const reason = binding?.scaffoldReason;
  useEffect(() => {
    if (layout !== "writing") return;
    if (reason === "created") {
      setLayout("done");
      return;
    }
    // A failed or half-written layout is also an answer, and one the console
    // can finish; so is the stamp clearing after we saw it set.
    if (reason === "partial" || reason === "failed") go("console");
    else if (sawQueued.current && queuedAt === undefined) go("console");
  }, [go, layout, queuedAt, reason]);
  useEffect(() => {
    if (layout !== "done") return;
    const handle = setTimeout(() => go("console"), options.layoutSettleMs ?? LAYOUT_SETTLE_MS);
    return () => clearTimeout(handle);
  }, [go, layout, options.layoutSettleMs]);
  useEffect(() => {
    if (layout !== "writing") return;
    const handle = setTimeout(() => go("console"), LAYOUT_WAIT_MS);
    return () => clearTimeout(handle);
  }, [go, layout]);

  /**
   * The probe landing is what moves the flow on — not the action returning.
   * `bindStorage` resolves as soon as the row is written, while the bucket is
   * still `unverified`.
   */
  useEffect(() => {
    if (step !== "storage") return;
    if (connectState.kind !== "connected") return;
    clearTimer();
    // Submitting the connect form is what makes it their bucket.
    const landed: StorageRoute = submitted ? "byo" : "managed";
    setRoute(landed);
    if (landed === "managed") void layOutFreshBucket();
    else go(afterStorage("connected", landed));
  }, [clearTimer, connectState.kind, go, layOutFreshBucket, step, submitted]);

  // ── Step 2 ──────────────────────────────────────────────────────────────────
  const forkOffer: ForkOffer =
    managed.free !== null
      ? { kind: "free", cap: managed.free.cap }
      : managed.available
        ? { kind: "paid", price: managed.price }
        : null;

  const pickManaged = useCallback(() => {
    setRoute("managed");
    if (managed.free !== null) {
      // No confirmation screen for a free bucket: nothing is charged, so
      // there is nothing to confirm. The start lands on the settling screen.
      managed.startFree();
      return;
    }
    managed.choose();
    setStep("storage");
  }, [managed]);

  // The free start is a mutation; once it lands the settling screen takes over.
  useEffect(() => {
    if (step === "fork" && managed.mode === "settling") setStep("storage");
  }, [managed.mode, step]);

  const pickOwn = useCallback(() => {
    setRoute("byo");
    setStep("storage");
  }, []);

  // ── The report ──────────────────────────────────────────────────────────────
  const dryRun = useMemo(
    () => (binding ? dryRunReport(binding as unknown as DryRunBinding) : null),
    [binding],
  );
  const finishDryRun = useCallback(() => go(afterDryRun()), [go]);

  const leaveStorage = useCallback(
    (outcome: StorageOutcome) => go(afterStorage(outcome, route)),
    [go, route],
  );
  const skipStorage = useCallback(() => leaveStorage("skipped"), [leaveStorage]);
  const continuePastStorage = useCallback(() => leaveStorage("unverified"), [leaveStorage]);

  return {
    step,
    shape: { route },
    owned: ownedContexts(workspaces),
    claimed,
    finished,

    name,
    setName,
    nameStatus: status,
    claiming,
    claimFailure,
    claim,
    canClaim: canClaim(status) && !claiming,

    forkOffer,
    pickManaged,
    pickOwn,
    startingFree: managed.startingFree,
    forkFailure: step === "fork" ? managed.failure : undefined,

    connect,
    connectState,
    managed: managed.available || managed.mode !== "choose" ? managed : null,
    layout,
    skipStorage,
    continuePastStorage,
    dryRun,
    finishDryRun,
  };
}
