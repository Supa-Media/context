/**
 * One chat's object: a phone's inbox or a group's, its queue, its alarm and every route the chat's state answers
 * (`inbox.ts`, `groupInbox.ts` and the rest). Moved out of `index.ts` unchanged, so the same object can run in the
 * gateway too (step 3 of Tex's config graph, docs/architecture/tex.md): what it reaches outside itself comes from
 * `env`, never from a module-level binding.
 */

import { jobRoute } from "./jobRoutes";
import { logged } from "./agentError";
import { type Inbound } from "./inbound";
import { accept, carryOnAfterSave, drain, react, type InboxDeps } from "./inbox";
import { carryOnAfterHandback } from "./handbackWatch";
import { countInbound } from "./textCounts";
import { checkReady } from "./ready";
import { checkGmail } from "./gmailWatch";
import type { Message } from "./reply";
import { textRoutine } from "./routines";
export { TexRoutines } from "./texRoutineDue";
import type { Picture } from "./line";
import { CARD_FOR_MS, hostPicture, MEDIA_FOR_MS, ORIGIN_KEY, serveMedia, workerOrigin } from "./media";
import { tellNewLine } from "./newLine";
import { sendblueKeys } from "./sendblue";
import { noteSendStatus, resendPlain, type SendStatus } from "./sendblueStatus";
import { type GroupMessage } from "./sendblueGroups";
import { heardInGroup } from "./groupVoice";
import { acceptGroup, acceptGroupRoutine, askControlPlane, drainGroup } from "./groupInbox";
import { membersChanged } from "./groupMembers";
import { flushWithReader } from "./chatRead";
import { CHAT_WHERE_KEY, chatDirectoryName, chatRoutineRunOf, chatWhereOf, WHERE_KEPT_KEY } from "./groupRoutines";
import { isBound, sha256Hex } from "./groupChat";
import { textsSessionDeps } from "./gatewaySession";
import { checkReview } from "./reviewWatch";
import { mintThreadsLink, readJobUpdate, serveThreads, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { jobAlarm } from "./jobRun";
import { resumePausedJobs } from "./jobPause";
import { jobUpdate } from "./jobTexts";
import { pageJobsOf, pageSteerResponse } from "./texPage";
import { simulatorEnabled, simulatorInbox } from "./simulator";
import { appCardConfig } from "./appCards";
import { watchGroupPresenceDaily, whapiKeys } from "./whapi";
import { noteCardDrawer } from "./noteCards";
import { answerHanded, failHanded } from "./groupTurnRun";
import type { GroupTurnParams } from "./groupTurnWorkflow";
import { inboxByName, inboxIdOf, objectByName } from "./objectPlace";
import { movedAlarm, placeGate, type MoveStorage } from "./inboxMove";
export { GroupTurnWorkflow } from "./groupTurnWorkflow";
export { JobRunWorkflow } from "./jobWorkflow";

import type { Env } from "./index";

export class SenderInbox implements DurableObject {
  /** Calls, alarms and handed-on work running now: an inbox moves only when there are none (`inboxMove.ts`). */
  private busy = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const stubs = (name: string) => objectByName(this.env.SENDER_INBOX, name);
    const gate = await placeGate(request, this.state.storage as unknown as MoveStorage, stubs, this.busy, (run) => this.state.blockConcurrencyWhile(run));
    if ("response" in gate) return gate.response;
    return await this.counted(() => this.serve(gate.request));
  }

  /** One call or alarm, counted as running until it ends. */
  private async counted<T>(run: () => Promise<T>): Promise<T> {
    this.busy += 1;
    try {
      return await run();
    } finally {
      this.busy -= 1;
    }
  }

  /** Work that outlives a call, counted as running until it settles. */
  private handOff = (work: Promise<unknown>): void => this.state.waitUntil(this.counted(() => Promise.resolve(work)));

  /** What a group just said, to its ledger now: by a turn's token, or for a chat Tex is set up in, by its ledger key (`chatRead.ts`). */
  private async flushChatter(message: GroupMessage): Promise<void> {
    const storage = this.state.storage;
    const binding = this.env.GATEWAY_TEXTS;
    const byLedger = binding !== undefined && !message.sms && (await isBound(storage, message)) ? { binding, ledger: await sha256Hex(`${message.line}:${message.groupId}`) } : undefined;
    if ((await flushWithReader(storage, message.groupId, () => Date.now(), byLedger)) === "none") console.log(JSON.stringify({ event: "tex_events", outcome: "no_way" }));
  }

  private async serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/sim/")) {
      // The Worker routes here only while the simulator is on; checked again
      // so the object never serves it on its own say-so.
      if (!simulatorEnabled(this.env.SIMULATOR)) return new Response(null, { status: 404 });
      const body = (await request.json()) as { keyHash: string; phone: string; text: string };
      return simulatorInbox(this.state.storage, path.slice("/sim/".length), body, Date.now(), (message) =>
        accept(this.state.storage, message, Date.now()),
      );
    }
    if (path === "/routine-text") {
      const body = (await request.json()) as { text?: unknown; idempotencyKey?: unknown; continues?: unknown; beside?: unknown };
      if (typeof body.text !== "string" || typeof body.idempotencyKey !== "string") {
        return new Response(null, { status: 400 });
      }
      const status = await textRoutine(
        this.state.storage,
        { text: body.text, idempotencyKey: body.idempotencyKey, ...(typeof body.continues === "string" ? { continues: body.continues } : {}), ...(typeof body.beside === "string" ? { beside: body.beside } : {}) },
        {
          fetch: (input, init) => fetch(input, init),
          linqApiKey: this.env.LINQ_API_KEY,
          sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET, this.env.SENDBLUE_STATUS_URL),
          whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
          now: () => Date.now(),
          simulator: simulatorEnabled(this.env.SIMULATOR),
          textCounts: this.env.TEX_COUNTS,
        },
      );
      return Response.json({ status });
    }
    if (path === "/new-line") {
      const body = (await request.json()) as { text?: unknown; dryRun?: unknown };
      if (typeof body.text !== "string" || typeof body.dryRun !== "boolean") return new Response(null, { status: 400 });
      const told = await tellNewLine(this.state.storage, { text: body.text, dryRun: body.dryRun }, {
        fetch: (input, init) => fetch(input, init),
        linqApiKey: this.env.LINQ_API_KEY,
        sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET, this.env.SENDBLUE_STATUS_URL),
        whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
        now: () => Date.now(),
        textCounts: this.env.TEX_COUNTS,
      });
      return Response.json({ told });
    }
    if (path === "/group-accept") {
      await this.keepOrigin(request);
      // Only this Worker's cron queues a routine's run (`/group-routine`); a webhook's message never names one.
      // Nor its `heard`: only this object sets that, from the recording itself (`groupVoice.ts`).
      const { routine: _routine, heard: _heard, ...sent } = (await request.json()) as GroupMessage;
      await this.keepWhere(sent);
      const message = await heardInGroup(sent, { fetch: (input, init) => fetch(input, init), gateway: this.env.GATEWAY_TEXTS });
      const outcome = await acceptGroup(this.state.storage, message, Date.now());
      // Counted under the sender's own inbox id, so one person is one person in a group and 1:1 (`textCounts.ts`).
      if ((outcome === "kept" || outcome === "queued") && message.routine === undefined && !message.reaction) {
        countInbound(this.env.TEX_COUNTS, "group", outcome === "queued" ? "for_tex" : "heard", inboxIdOf(this.env.SENDER_INBOX, message.from));
      }
      // What the chat just said goes to its ledger now, not at Tex's next turn, so its history keeps up (`chatRead.ts`).
      if (outcome === "kept" || outcome === "queued") this.handOff(this.flushChatter(message));
      // The group-typing experiment: ask Whapi for this group's presences once a day (`whapi.ts`); never blocks a message.
      const whapi = whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE);
      if (whapi !== null && !message.sms) await watchGroupPresenceDaily(this.state.storage, (input, init) => fetch(input, init), whapi, message.groupId, Date.now());
      return Response.json({ outcome });
    }
    // Whapi said this group's people changed (`index.ts` whapiWebhook): only this Worker's webhook reaches it.
    if (path === "/group-members-changed") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return Response.json({ marked: await membersChanged(this.state.storage, Date.now()) });
    }
    // A group turn's workflow (`groupTurnWorkflow.ts`): only this Worker's workflow reaches these.
    if (path === "/group-answer" || path === "/group-failed") {
      const { turn } = (await request.json()) as { turn?: unknown };
      if (typeof turn !== "string") return new Response(null, { status: 400 });
      const deps = this.deps();
      return Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(this.state.storage, deps, turn) });
    }
    if (path === "/group-routine") {
      const run = chatRoutineRunOf(await request.json());
      if (run === null) return new Response(null, { status: 400 });
      return Response.json({ outcome: await acceptGroupRoutine(this.state.storage, run, Date.now()) });
    }
    // A chat's directory entry (`groupRoutines.ts`): where the chat with this object's key is.
    if (path === "/chat-where") {
      if (request.method === "GET") return Response.json((await this.state.storage.get(CHAT_WHERE_KEY)) ?? null);
      const where = chatWhereOf(await request.json());
      if (where === null) return new Response(null, { status: 400 });
      await this.state.storage.put(CHAT_WHERE_KEY, where);
      return Response.json({ ok: true });
    }
    // A background job's own object is started, run, steered and mailed here (`jobRoutes.ts`); it reports to its chat's inbox below.
    const job = await jobRoute(path, request, this.state.storage, this.env.JOB_RUN, () => this.jobDeps());
    if (job !== undefined) return job;
    if (path === "/job-update") {
      const update = readJobUpdate(await request.json());
      if (update === null) return new Response(null, { status: 400 });
      return Response.json({ known: await jobUpdate(this.state.storage, this.deps(), update) });
    }
    if (path === "/page-jobs") return Response.json(await pageJobsOf(this.state.storage, Date.now()));
    if (path === "/page-steer") return await pageSteerResponse(this.state.storage, await request.json().catch(() => null), async (id, next) => (await this.deps().steerJob?.(id, next)) ?? false);
    if (path === "/send-status") {
      const status = (await request.json()) as SendStatus;
      return Response.json({ outcome: await noteSendStatus(this.state.storage, status, Date.now(), resendPlain(this.state.storage, this.deps(), Date.now)) });
    }
    if (path === "/react") {
      const inbound = (await request.json()) as Extract<Inbound, { kind: "reaction" }>;
      return Response.json({ outcome: await react(this.state.storage, inbound, Date.now()) });
    }
    if (path.startsWith("/threads/")) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return serveThreads(this.state.storage, path.slice("/threads/".length), Date.now());
    }
    if (path.startsWith("/media/")) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return serveMedia(this.state.storage, path.slice("/media/".length), Date.now());
    }
    await this.keepOrigin(request);
    const message = (await request.json()) as Message;
    const outcome = await accept(this.state.storage, message, Date.now());
    if (outcome === "queued" && message.channel !== "simulator" && !message.tapback) countInbound(this.env.TEX_COUNTS, "one", "text", inboxIdOf(this.env.SENDER_INBOX, message.from));
    return Response.json({ outcome });
  }

  async alarm(): Promise<void> {
    // A moved inbox's alarm only clears its old copy (`inboxMove.ts`).
    if (!(await movedAlarm(this.state.storage as unknown as MoveStorage, Date.now()))) await this.counted(() => this.runAlarm());
  }

  private async runAlarm(): Promise<void> {
    // A group's object has only `gpending:` keys, a phone's only `pending:`; each drain finds the other's empty.
    // Each stage names its throw in the logs, then throws on as before, so the alarm still retries (`agentError.ts`).
    await logged("alarm_group", () => drainGroup(this.state.storage, this.deps()));
    await logged("alarm_inbox", () => drain(this.state.storage, this.deps()));
    await logged("alarm_ready", () => checkReady(this.state.storage, this.deps()));
    await logged("alarm_gmail", () => checkGmail(this.state.storage, this.deps()));
    await logged("alarm_carry_on", () => carryOnAfterSave(this.state.storage, this.deps()));
    await logged("alarm_handed_back", () => carryOnAfterHandback(this.state.storage, this.deps()));
    // A chat quiet long enough has its conversation scored (`reviewWatch.ts`).
    await logged("alarm_review", () => checkReview(this.state.storage, { ...this.deps(), mintGroup: (message, people) => this.mintGroup(message, people) }));
    // A job's object has only `jobrun`; every other object finds nothing to run.
    await logged("alarm_job", () => jobAlarm(this.state.storage, this.jobDeps(), this.env.JOB_RUN !== undefined));
    // A chat's job paused at the daily limit starts again once it resets (`jobPause.ts`).
    await logged("alarm_paused_jobs", () => resumePausedJobs(this.state.storage, this.deps().steerJob, Date.now()));
  }

  private jobDeps() {
    return { ...this.deps(), report: (inbox: string, update: JobUpdate) => this.reportJob(inbox, update) };
  }

  /** A group's token for its review, minted as a tagged turn's is; null unless the chat is ready. */
  private async mintGroup(message: GroupMessage, people: string[]) {
    const asked = await askControlPlane(this.deps(), message, people, null);
    if (asked.status !== "ready" || asked.accessToken === undefined) return null;
    return { accessToken: asked.accessToken, ...(asked.handle ? { handle: asked.handle } : {}), names: asked.names ?? [] };
  }

  /** A job's word to the inbox it belongs to: taken once it answers 200. */
  private async reportJob(inbox: string, update: JobUpdate): Promise<boolean> {
    const stub = inboxByName(this.env.SENDER_INBOX, inbox);
    const response = await stub.fetch("https://inbox/job-update", { method: "POST", body: JSON.stringify(update) });
    return response.ok;
  }

  /** Tell the chat's directory entry where this chat is, once, so its routines can find it (`groupRoutines.ts`). */
  private async keepWhere(message: GroupMessage): Promise<void> {
    if (message.sms || (await this.state.storage.get(WHERE_KEPT_KEY)) !== undefined) return;
    const key = await sha256Hex(`${message.line}:${message.groupId}`);
    const directory = inboxByName(this.env.SENDER_INBOX, chatDirectoryName(key));
    const where = { line: message.line, groupId: message.groupId };
    const response = await directory.fetch("https://inbox/chat-where", { method: "POST", body: JSON.stringify(where) });
    if (response.ok) await this.state.storage.put(WHERE_KEPT_KEY, true);
  }

  /** The Worker's own address, kept for pictures served back to Sendblue (`media.ts`). */
  private async keepOrigin(request: Request): Promise<void> {
    const origin = workerOrigin(new URL(request.url).searchParams.get("origin"));
    if (origin !== null && (await this.state.storage.get<string>(ORIGIN_KEY)) !== origin) {
      await this.state.storage.put(ORIGIN_KEY, origin);
    }
  }

  private deps(): InboxDeps & { startTurn?: (turn: string) => Promise<void>; answerFirst?: (work: Promise<unknown>) => void } {
    const workflow = this.env.GROUP_TURN;
    return {
      ...(workflow ? { startTurn: (turn: string) => startGroupTurn(workflow, this.state.id.toString(), turn), answerFirst: (work: Promise<unknown>) => this.handOff(work) } : {}),
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: this.env.CONTROL_PLANE_ORIGIN,
      workerSecret: this.env.AGENT_WORKER_SECRET,
      gatewayOrigin: this.env.GATEWAY_ORIGIN,
      linqApiKey: this.env.LINQ_API_KEY,
      sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET, this.env.SENDBLUE_STATUS_URL),
      whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
      appCard: appCardConfig(this.env),
      waitUntil: (promise) => this.handOff(promise),
      textTiming: this.env.TEX_TEXTS,
      textCounts: this.env.TEX_COUNTS,
      ...(this.env.GATEWAY_TEXTS ? { texts: textsSessionDeps(this.env.GATEWAY_TEXTS, this.state.storage) } : {}),
      noteCardPicture: noteCardDrawer((input, init) => fetch(input, init), this.env.CONTROL_PLANE_ORIGIN, this.env.AGENT_WORKER_SECRET),
      hostPicture: async (picture: Picture) =>
        hostPicture(
          this.state.storage,
          await this.state.storage.get<string>(ORIGIN_KEY),
          this.state.id.toString(),
          picture,
          Date.now(),
          picture.title ? CARD_FOR_MS : MEDIA_FOR_MS,
        ),
      threadsLink: () => mintThreadsLink(this.state.storage, this.state.id.toString(), Date.now()),
      images: this.env.IMAGES,
      now: () => Date.now(),
      spawnJob: async (id: string, run: JobRun) => {
        const stub = inboxByName(this.env.SENDER_INBOX, `job:${id}`);
        const response = await stub.fetch("https://inbox/job-start", { method: "POST", body: JSON.stringify(run) });
        if (!response.ok) throw new Error("job not started");
      },
      steerJob: async (id: string, steer: JobSteer) => {
        const stub = inboxByName(this.env.SENDER_INBOX, `job:${id}`);
        const response = await stub.fetch("https://inbox/job-steer", { method: "POST", body: JSON.stringify(steer) });
        return response.ok && ((await response.json()) as { taken?: unknown }).taken === true;
      },
    };
  }
}

/** Start the workflow for one group turn; one already started under this id counts as started. */
async function startGroupTurn(workflow: Workflow<GroupTurnParams>, inbox: string, turn: string): Promise<void> {
  try {
    await workflow.create({ id: turn, params: { inbox, turn } });
  } catch (error) {
    await workflow.get(turn).catch(() => {
      throw error;
    });
  }
}
