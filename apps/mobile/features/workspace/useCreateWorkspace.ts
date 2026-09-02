/**
 * Creating a workspace, wired to the control plane.
 *
 * The judgement lives in `create.ts` and `presets.ts`; this holds the
 * subscriptions, the mutations and the `useState` calls, exactly as
 * `../onboarding/useOnboarding` does.
 *
 * ## What it reuses, and the one thing it must not
 *
 * The name field, the folder editor and the connect form are the same code
 * onboarding uses — the rules for a slug, a folder name and an S3 endpoint do
 * not change because the context has more than one member. What it does **not**
 * reuse is `useOnboarding` itself: that controller creates a `personal`
 * context, treats "already owns one" as a reason to redirect, reads the
 * ingestion policy, and builds a seed prompt. Three of those are wrong here and
 * the fourth is about a capture address a workspace does not have.
 *
 * ## `createWorkspace` is called once, and the flow remembers it
 *
 * The name claim is permanent — there is no release path — so a controller that
 * could call it twice would burn a name every time somebody pressed a button
 * twice. `created` is the guard: it is set from the mutation's own return
 * value, and every later step reads the workspace id from it rather than from
 * the context list, which has not necessarily caught up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAction,
  useMutation,
  useQueries,
  type RequestForQueries,
} from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import type { AssignableRole } from "../console/members/members";
import {
  toBindStorageArgs,
  type ConnectFormValues,
  type Provider,
} from "../console/storage/connect";
import { describeCreateFailure, describeStructureFailure, type CreateFailure } from "../onboarding/errors";
import {
  canClaim,
  nameStatus,
  normalizedName,
  shouldCheckAvailability,
  type NameAvailability,
  type NameStatus,
} from "../onboarding/name";
import {
  canApplyStructure,
  toApplyStructureArgs,
  validateCustomFolders,
  type CustomFolderRow,
  type FolderErrors,
} from "../onboarding/structure";
import {
  CONNECT_TIMEOUT_MS,
  connectProgress,
  type ConnectState,
  type WatchedBinding,
} from "../onboarding/verify";
import {
  afterWorkspaceLayout,
  afterWorkspaceStorage,
  canCreateWorkspace,
  draftInvite,
  removeInvite,
  setInviteRole,
  slugSuggestion,
  type InviteDraftRejection,
  type InviteSendResult,
  type PendingInvite,
  type WorkspaceFlowShape,
  type WorkspaceStepKey,
  type WorkspaceStorageOutcome,
} from "./create";
import {
  DEFAULT_PRESET,
  presetRows,
  templateFor,
  type WorkspacePresetKey,
} from "./presets";

/** Convex hands back `undefined` while loading and an `Error` when a query throws. */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export interface CreatedWorkspace {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
}

export interface CreateWorkspaceController {
  step: WorkspaceStepKey;
  shape: WorkspaceFlowShape;
  created: CreatedWorkspace | null;

  // ── Step 1: the name ──────────────────────────────────────────────────────
  displayName: string;
  setDisplayName: (value: string) => void;
  slug: string;
  setSlug: (value: string) => void;
  /** True while the slug is still following the display name. */
  slugAuto: boolean;
  nameStatus: NameStatus;
  creating: boolean;
  createFailure: CreateFailure | null;
  canCreate: boolean;
  create: () => Promise<void>;

  // ── Step 2: the bucket ────────────────────────────────────────────────────
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  connectState: ConnectState;
  skipStorage: () => void;
  continuePastStorage: () => void;

  // ── Step 3: the layout ────────────────────────────────────────────────────
  preset: WorkspacePresetKey;
  setPreset: (key: WorkspacePresetKey) => void;
  folders: CustomFolderRow[];
  setFolders: (rows: CustomFolderRow[]) => void;
  folderErrors: FolderErrors;
  applying: boolean;
  structureFailure: CreateFailure | null;
  canApply: boolean;
  applyStructure: () => Promise<void>;
  skipStructure: () => void;

  // ── Step 4: the people ────────────────────────────────────────────────────
  inviteDraft: string;
  setInviteDraft: (value: string) => void;
  draftRole: AssignableRole;
  setDraftRole: (role: AssignableRole) => void;
  draftRejection: InviteDraftRejection | null;
  queued: PendingInvite[];
  addInvite: () => void;
  dropInvite: (index: number) => void;
  changeInviteRole: (index: number, role: AssignableRole) => void;
  sending: boolean;
  sendResult: InviteSendResult | null;
  sendInvites: () => Promise<void>;
  skipInvites: () => void;
}

export function useCreateWorkspace(): CreateWorkspaceController {
  const [step, setStep] = useState<WorkspaceStepKey>("name");
  // Starts at `connected` so the step rail draws the full five before anything
  // has gone wrong. Only ever narrowed, by an explicit choice on the storage
  // step. Same reasoning as `useOnboarding`.
  const [storage, setStorage] = useState<WorkspaceStorageOutcome>("connected");
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);

  /* ── Step 1: the name ───────────────────────────────────────────────────── */

  const [displayName, setDisplayNameRaw] = useState("");
  const [slug, setSlugRaw] = useState("");
  // Once the handle is touched it stops following the label. See
  // `slugSuggestion` for why a suggestion that keeps overwriting is worse than
  // no suggestion.
  const [slugAuto, setSlugAuto] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
  const createWorkspaceMutation = useMutation(api.functions.workspaces.createWorkspace);

  const setDisplayName = useCallback(
    (value: string) => {
      setDisplayNameRaw(value);
      setCreateFailure(null);
      if (slugAuto) setSlugRaw(slugSuggestion(value));
    },
    [slugAuto],
  );

  const setSlug = useCallback((value: string) => {
    setSlugAuto(false);
    setSlugRaw(value);
    setCreateFailure(null);
  }, []);

  const normalized = normalizedName(slug);

  const availabilitySpec = useMemo<RequestForQueries>(() => {
    // The shared frozen object, not a fresh `{}` — see `console/querySpec.ts`.
    if (!shouldCheckAvailability(slug)) return EMPTY_QUERY_SPEC;
    return {
      availability: {
        query: api.functions.names.checkNameAvailable,
        args: { name: normalized },
      },
    };
  }, [slug, normalized]);

  const availabilityResults = useQueries(availabilitySpec);
  const availability = usable<NameAvailability>(availabilityResults.availability);
  const status = nameStatus(slug, availability);

  const create = useCallback(async () => {
    // Narrowed rather than merely checked: only an `available` status carries a
    // normalized name, and it is the only one that may be claimed. `created`
    // guards the second press — the claim is permanent.
    if (status.kind !== "available" || creating || created !== null) return;
    const label = displayName.trim();
    if (label.length === 0) return;
    setCreating(true);
    setCreateFailure(null);
    try {
      const result = await createWorkspaceMutation({
        slug: status.normalized,
        displayName: label,
        kind: "shared",
        // `structureTemplate` is deliberately **not** sent. Passing a value is
        // the decision, and it would be made two screens before the person is
        // shown the choice — see the same note in `useOnboarding`. The layout
        // travels with `applyStructure`, which overwrites the column.
      });
      setCreated({
        workspaceId: result.workspaceId,
        slug: result.slug,
        displayName: label,
      });
      setStep("storage");
    } catch (error) {
      setCreateFailure(describeCreateFailure(error));
    } finally {
      setCreating(false);
    }
  }, [createWorkspaceMutation, created, creating, displayName, status]);

  /* ── Step 2: the bucket ─────────────────────────────────────────────────── */

  const bindStorage = useAction(api.functions.storage.bindStorage);
  const [submitted, setSubmitted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const bindingSpec = useMemo<RequestForQueries>(() => {
    if (created === null) return EMPTY_QUERY_SPEC;
    return {
      binding: {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: created.workspaceId },
      },
    };
  }, [created]);

  const bindingResults = useQueries(bindingSpec);
  const binding = usable<(WatchedBinding & { scaffoldReason?: string }) | null>(
    bindingResults.binding,
  );

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
      if (created === null) throw new Error("No workspace to connect a bucket to.");
      setSubmitted(true);
      setTimedOut(false);
      clearTimer();
      timer.current = setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
      try {
        const args = toBindStorageArgs(values, created.workspaceId);
        const result = await bindStorage({
          ...args,
          workspaceId: created.workspaceId,
          provider: args.provider as Provider,
        });
        return { status: result.status };
      } catch (error) {
        // The form owns the failure display for a rejected bind; reset so its
        // own error panel is the only one on screen.
        clearTimer();
        setSubmitted(false);
        throw error;
      }
    },
    [bindStorage, clearTimer, created],
  );

  /**
   * The probe landing is what moves the flow on, not the action returning —
   * `bindStorage` resolves while the bucket is still `unverified`.
   */
  useEffect(() => {
    if (step !== "storage") return;
    if (connectState.kind !== "connected") return;
    clearTimer();
    setStep(afterWorkspaceStorage("connected"));
  }, [clearTimer, connectState.kind, step]);

  const skipStorage = useCallback(() => {
    setStorage("skipped");
    setStep(afterWorkspaceStorage("skipped"));
  }, []);

  const continuePastStorage = useCallback(() => {
    setStorage("unverified");
    setStep(afterWorkspaceStorage("unverified"));
  }, []);

  /* ── Step 3: the layout ─────────────────────────────────────────────────── */

  const [preset, setPresetRaw] = useState<WorkspacePresetKey>(DEFAULT_PRESET);
  const [folders, setFolders] = useState<CustomFolderRow[]>(() =>
    presetRows(DEFAULT_PRESET),
  );
  const [applying, setApplying] = useState(false);
  const [structureFailure, setStructureFailure] = useState<CreateFailure | null>(null);
  const applyStructureMutation = useMutation(api.functions.workspaces.applyStructure);

  /**
   * Choosing a preset replaces the rows.
   *
   * Which does discard edits — deliberately. The alternative, merging, produces
   * a folder list that is neither preset and that nobody chose; and the rows are
   * visible on the same screen, so the loss is on screen rather than a surprise
   * two steps later.
   */
  const setPreset = useCallback((key: WorkspacePresetKey) => {
    setPresetRaw(key);
    setFolders(presetRows(key));
    setStructureFailure(null);
  }, []);

  const template = templateFor(preset);
  const folderErrors = validateCustomFolders(folders);

  const skipStructure = useCallback(() => setStep(afterWorkspaceLayout()), []);

  const applyStructure = useCallback(async () => {
    if (created === null || applying) return;
    if (!canApplyStructure(template, folders, folderErrors)) return;
    setApplying(true);
    setStructureFailure(null);
    try {
      const args = toApplyStructureArgs(created.workspaceId, template, folders);
      await applyStructureMutation({ ...args, workspaceId: created.workspaceId });
      setStep(afterWorkspaceLayout());
    } catch (error) {
      setStructureFailure(describeStructureFailure(error));
    } finally {
      setApplying(false);
    }
  }, [applyStructureMutation, applying, created, folderErrors, folders, template]);

  /* ── Step 4: the people ─────────────────────────────────────────────────── */

  const inviteMutation = useMutation(api.functions.invitations.inviteMember);
  const [inviteDraft, setInviteDraftRaw] = useState("");
  const [draftRole, setDraftRole] = useState<AssignableRole>("editor");
  const [draftRejection, setDraftRejection] = useState<InviteDraftRejection | null>(null);
  const [queued, setQueued] = useState<PendingInvite[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<InviteSendResult | null>(null);

  const setInviteDraft = useCallback((value: string) => {
    setInviteDraftRaw(value);
    setDraftRejection(null);
  }, []);

  const addInvite = useCallback(() => {
    const result = draftInvite(inviteDraft, draftRole, queued);
    if (!result.ok) {
      setDraftRejection(result.reason);
      return;
    }
    setQueued((current) => [...current, result.invite]);
    setInviteDraftRaw("");
    setDraftRejection(null);
  }, [draftRole, inviteDraft, queued]);

  const dropInvite = useCallback((index: number) => {
    setQueued((current) => removeInvite(current, index));
  }, []);

  const changeInviteRole = useCallback((index: number, role: AssignableRole) => {
    setQueued((current) => setInviteRole(current, index, role));
  }, []);

  /**
   * Send them one at a time, and keep the failures.
   *
   * Sequential rather than `Promise.all` because `inviteMember` is rate limited
   * per account: firing five at once is the shape most likely to meet the limit
   * and the shape where meeting it tells you least about which ones landed.
   *
   * A failure does not discard the successes — those invitations exist now, and
   * re-sending one supersedes a live row. So the queue is replaced by exactly
   * what did not go, and the step reports both halves.
   */
  const sendInvites = useCallback(async () => {
    if (created === null || sending) return;
    if (queued.length === 0) {
      setStep("done");
      return;
    }
    setSending(true);
    const sent: PendingInvite[] = [];
    const failed: { invite: PendingInvite; error: unknown }[] = [];
    for (const invite of queued) {
      try {
        await inviteMutation({
          workspaceId: created.workspaceId,
          invitee: invite.invitee,
          role: invite.role,
        });
        sent.push(invite);
      } catch (error) {
        failed.push({ invite, error });
      }
    }
    setQueued(failed.map((entry) => entry.invite));
    setSendResult({ sent, failed });
    setSending(false);
    if (failed.length === 0) setStep("done");
  }, [created, inviteMutation, queued, sending]);

  const skipInvites = useCallback(() => setStep("done"), []);

  return {
    step,
    shape: { storage },
    created,

    displayName,
    setDisplayName,
    slug,
    setSlug,
    slugAuto,
    nameStatus: status,
    creating,
    createFailure,
    canCreate:
      canCreateWorkspace({ displayName, nameReady: canClaim(status), creating }) &&
      created === null,
    create,

    connect,
    connectState,
    skipStorage,
    continuePastStorage,

    preset,
    setPreset,
    folders,
    setFolders,
    folderErrors,
    applying,
    structureFailure,
    canApply: canApplyStructure(template, folders, folderErrors) && !applying,
    applyStructure,
    skipStructure,

    inviteDraft,
    setInviteDraft,
    draftRole,
    setDraftRole,
    draftRejection,
    queued,
    addInvite,
    dropInvite,
    changeInviteRole,
    sending,
    sendResult,
    sendInvites,
    skipInvites,
  };
}
