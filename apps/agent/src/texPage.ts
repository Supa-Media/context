/**
 * The Tex page's view of a chat's background jobs (`jobs.ts`): what the
 * gateway's Tex page (`TexRoutines.pageJobs` / `pageSteer`, `texRoutineDue.ts`)
 * reads and steers, for one chat that the gateway names by its phone (a 1:1
 * chat) or by its group key (a group, found through the key's directory entry
 * `chatDirectoryName`).
 *
 * Only what the chat's inbox keeps is shown: each job's title, state, status,
 * times, steps and a finished job's report. Who asked is not kept in the
 * chat's entry (only in the job's own object), so a page never names one.
 * A steer reaches only a job this chat's inbox lists, never another chat's.
 */

import { chatDirectoryName, chatWhereOf } from "./groupRoutines";
import { lastTurnPeople } from "./groupChat";
import { groupInboxName } from "./groupInbox";
import { inboxByName } from "./objectPlace";
import type { InboxStorage } from "./inbox";
import { JOB_KEPT_MS, JOB_PREFIX, JOB_STALE_MS, MACHINE_JOB_STALE_MS, type JobEntry, type JobState, type JobStep, type JobSteer } from "./jobs";

/** Most jobs a page is shown, newest first. */
export const MAX_PAGE_JOBS = 40;
/** A steer's text, as long as the chat's own steers may be. */
const MAX_PAGE_STEER_TEXT = 1_000;
const PHONE = /^\+[1-9]\d{6,14}$/;
const GROUP_KEY = /^[0-9a-f]{64}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One job as a page shows it. `for` is never set: the chat's entry keeps no asker's name. */
export type PageJob = {
  id: string;
  title: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  status?: string;
  steps: JobStep[];
  result?: string;
  for?: string;
  /** Stopped by a person (`jobRun.ts`): shown as stopped, not failed. */
  stopped?: true;
  /** The person's own computer it runs on, by id, with the name and coding tool it was started with; absent in Tex's cloud. */
  on?: { id: string; name: string; tool?: "claude" | "codex" };
};

/** What a chat's inbox answers a page: its jobs, and for a group the people hash its browser is tagged by. */
export type PageJobs = { now: number; jobs: PageJob[]; people?: string };

/** Where an entry's job runs, for the page: its computer, or nothing for Tex's cloud. An entry from before names were kept says "your computer". */
function pageMachineOf(entry: JobEntry): { on?: PageJob["on"] } {
  if (typeof entry.on !== "string" && entry.machine !== true) return {};
  const id = typeof entry.on === "string" ? entry.on : "machine";
  const name = typeof entry.onName === "string" && entry.onName.trim() !== "" ? entry.onName.trim().slice(0, 100) : "your computer";
  const tool = entry.onTool === "claude" || entry.onTool === "codex" ? entry.onTool : undefined;
  return { on: { id, name, ...(tool ? { tool } : {}) } };
}

/** Which chat a page names: a 1:1 chat's phone, or a group's key. */
export type PageChat = { phone: string } | { groupKey: string };

/** A steer from a page, read strictly. */
export type PageSteer = { id: string; text: string; stop?: true };

/**
 * Every job the chat's inbox keeps, running and finished, newest first, at
 * most `MAX_PAGE_JOBS`. Prunes the way `chatJobs` does: a finished job past
 * `JOB_KEPT_MS` is deleted, and a running one past `JOB_STALE_MS` is marked
 * failed, since its object is gone.
 */
export async function pageJobsOf(storage: InboxStorage, now: number): Promise<PageJobs> {
  const entries = await storage.list<JobEntry>({ prefix: JOB_PREFIX });
  const kept: JobEntry[] = [];
  for (const [key, entry] of entries) {
    if (entry.state !== "running" && now - (entry.finishedAt ?? entry.startedAt) > JOB_KEPT_MS) {
      await storage.delete(key);
      continue;
    }
    // A job on their computer may run hours longer than a cloud job (`jobs.ts`), so it is stale later.
    if (entry.state === "running" && now - entry.startedAt > (entry.machine ? MACHINE_JOB_STALE_MS : JOB_STALE_MS)) {
      const stopped = { ...entry, state: "failed" as const, finishedAt: now };
      await storage.put(key, stopped);
      kept.push(stopped);
      continue;
    }
    kept.push(entry);
  }
  const jobs = kept
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_PAGE_JOBS)
    .map((entry): PageJob => ({
      id: entry.id,
      title: entry.title,
      state: entry.state,
      startedAt: entry.startedAt,
      ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      steps: entry.steps ?? [],
      ...(entry.state !== "running" && entry.result ? { result: entry.result } : {}),
      ...(entry.stopped === true ? { stopped: true as const } : {}),
      ...pageMachineOf(entry),
    }));
  // A group's browser is tagged by its people (`lastTurnPeople`); a 1:1 inbox keeps none.
  const people = await lastTurnPeople(storage);
  return { now, jobs, ...(people !== null ? { people } : {}) };
}

/** A page's chat, read strictly: exactly one of a phone or a group key, each in its own shape. Anything else is null. */
export function readPageChat(value: unknown): PageChat | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { phone, groupKey } = value as Record<string, unknown>;
  if (phone !== undefined && groupKey !== undefined) return null;
  if (phone !== undefined) return typeof phone === "string" && PHONE.test(phone) ? { phone } : null;
  if (groupKey !== undefined) return typeof groupKey === "string" && GROUP_KEY.test(groupKey) ? { groupKey } : null;
  return null;
}

/**
 * The inbox a page's chat is kept in, or null when there is no such chat. A
 * group's key is looked up in its directory entry, which knows the group.
 */
export async function inboxForPageChat(env: { SENDER_INBOX: DurableObjectNamespace }, chat: PageChat): Promise<{ fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } | null> {
  if ("phone" in chat) return inboxByName(env.SENDER_INBOX, chat.phone);
  const directory = inboxByName(env.SENDER_INBOX, chatDirectoryName(chat.groupKey));
  const found = await directory.fetch("https://inbox/chat-where", { method: "GET" });
  const where = found.ok ? chatWhereOf(await found.json()) : null;
  if (where === null) return null;
  return inboxByName(env.SENDER_INBOX, groupInboxName(where.groupId));
}

/**
 * A steer from a page, read strictly. `stop` with no text says "Stop.". A
 * steer with neither a stop nor any text is null.
 */
export function readPageSteer(value: unknown): PageSteer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, text, stop } = value as Record<string, unknown>;
  if (typeof id !== "string" || !JOB_ID.test(id)) return null;
  if (text !== undefined && typeof text !== "string") return null;
  const said = (text ?? "").trim().slice(0, MAX_PAGE_STEER_TEXT);
  if (stop === true) return { id, text: said || "Stop.", stop: true };
  return said === "" ? null : { id, text: said };
}

/**
 * Steer one of this chat's jobs for a page. Only a job the inbox keeps
 * (`job:<id>`) is sent anything; `send` is the inbox's own `steerJob`, which
 * reaches the job's object. False for an unknown job, or when the send fails.
 */
export async function pageSteer(storage: InboxStorage, steer: PageSteer, send: (id: string, steer: JobSteer) => Promise<boolean>): Promise<boolean> {
  if ((await storage.get<JobEntry>(`${JOB_PREFIX}${steer.id}`)) === undefined) return false;
  return await send(steer.id, { id: steer.id, text: steer.text, ...(steer.stop ? { stop: true as const } : {}) }).catch(() => false);
}

/** `POST /page-steer` in the chat's inbox: the body read strictly (400 when it is not a steer), then `pageSteer`'s answer as `{taken}`. */
export async function pageSteerResponse(storage: InboxStorage, body: unknown, send: (id: string, steer: JobSteer) => Promise<boolean>): Promise<Response> {
  const steer = readPageSteer(body);
  if (steer === null) return new Response(null, { status: 400 });
  return Response.json({ taken: await pageSteer(storage, steer, send) });
}
