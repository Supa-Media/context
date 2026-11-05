/**
 * The workspace object's machine calls (`ws.machine.*`): the gateway adds a
 * machine the control plane paired, the app's owner changes its settings, and
 * a job takes a slot, sends a run mail, interrupts or cancels it, and reads
 * what happened (docs/decisions/texting-assistant/machines.md).
 *
 * Who is asking was checked before the call arrived: the gateway checks the
 * app's session and role for settings, and only the texting Worker's job
 * objects reach the run calls. What is checked here is the machine's own
 * rules (`machines.js` `admit`), which no caller can widen: an assignment for
 * somebody the owner did not allow, past a limit, outside the folders, or on
 * a full machine is refused whatever the caller says.
 */

import protocol from "../../../../packages/shared/src/machineProtocol.cjs";
import { MachineRefused } from "./machines.js";

const { invalid } = protocol;

export const MACHINE_OPS = Object.freeze({
  ADD: "ws.machine.add",
  LIST: "ws.machine.list",
  GET: "ws.machine.get",
  SET: "ws.machine.set",
  REMOVE: "ws.machine.remove",
  ASSIGN: "ws.machine.assign",
  DELIVER: "ws.machine.deliver",
  INTERRUPT: "ws.machine.interrupt",
  CANCEL: "ws.machine.cancel",
  RUN: "ws.machine.run",
  ANSWER: "ws.machine.answer",
  RAISE: "ws.machine.raise",
  MAIL: "ws.machine.mail",
  SIGN_IN: "ws.machine.signIn",
  INSTALL: "ws.machine.install",
});
const OPS = new Set(Object.values(MACHINE_OPS));

const RUN_ID = /^run_[0-9a-f]{24}$/;
const refused = (code, extra = {}) => Response.json({ ok: false, code, ...extra });

function mintRunId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `run_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** What the app and the page see of a machine: everything but its key. */
function shown(store, machine) {
  const { publicKey: _key, ...rest } = machine;
  return { ...rest, asks: store.machines.pendingAsks(machine.id), online: store.machineSockets.online(machine.id), used: store.machines.used(machine.id), running: store.machines.liveRuns(machine.id).map((run) => ({ runId: run.runId, jobId: run.jobId, chat: run.chat, fromOwner: run.fromOwner, title: run.title ?? null, state: run.state, startedAt: run.startedAt })) };
}

function assign(store, fields) {
  const { machines, machineSockets } = store;
  const machineId = fields.machineId;
  const machine = machines.get(machineId);
  if (!machine) return refused("unknown_machine");
  const asked = { chat: String(fields.chat ?? ""), askerId: String(fields.askerId ?? ""), jobId: String(fields.jobId ?? "") };
  // "Ask me first" is the owner's own yes, kept here: never a caller's word that it was given.
  const ask = { ...asked, fromOwner: fields.fromOwner === true, tool: fields.tool, folder: fields.folder, approved: machines.approved(machineId, asked), computerUse: fields.computerUse === true };
  const held = machines.admit(machineId, ask, machineSockets.online(machineId));
  if (held?.code === "ask_first") {
    const waiting = machines.ask(machineId, { ...asked, title: fields.title, chatName: fields.chatName, chatKey: fields.chatKey });
    return refused(waiting.state === "no" ? "declined" : "ask_first", { askId: waiting.id, ...(waiting.fresh === true ? { fresh: true } : {}) });
  }
  if (held !== null) return refused(held.code, held.until ? { until: held.until } : {});
  const powers = machines.powers(machineId, ask);
  const now = machines.now();
  // A part never runs past the machine's longest job, whatever the caller asked.
  const deadline = Math.min(Number.isSafeInteger(fields.deadline) ? fields.deadline : now + machine.limits.longestRunMs, now + machine.limits.longestRunMs);
  // Plain Claude Code for the owner and for anyone they let in (owner, 2026-11-04): the caller's permission stands.
  const permission = fields.permission;
  // The gateway mints the id first when it mints the run's grant for it (`machines/jobRoutes.js`).
  const runId = typeof fields.runId === "string" && RUN_ID.test(fields.runId) ? fields.runId : mintRunId();
  const frame = {
    type: "assign",
    runId,
    jobId: fields.jobId,
    part: fields.part,
    ...(typeof fields.title === "string" ? { title: fields.title.slice(0, 200) } : {}),
    tool: ask.tool,
    folder: ask.folder,
    ...(typeof fields.repo === "string" ? { repo: fields.repo } : {}),
    permission,
    brief: fields.brief,
    doneWhen: fields.doneWhen ?? "",
    ...(typeof fields.advice === "string" ? { advice: fields.advice } : {}),
    ...(typeof fields.resumeSession === "string" ? { resumeSession: fields.resumeSession } : {}),
    grant: fields.grant,
    deadline,
    fromOwner: ask.fromOwner,
    ...(typeof fields.asker === "string" ? { asker: fields.asker.slice(0, 100) } : {}),
    ...(typeof fields.chatName === "string" ? { chat: fields.chatName.slice(0, 100) } : {}),
    network: powers.network,
    helpers: powers.helpers,
    computerUse: powers.computerUse,
  };
  const why = invalid("Assign", frame);
  if (why !== null) return refused("bad_assign", { why });
  machines.start({ runId, machineId, jobId: fields.jobId, chat: ask.chat, fromOwner: ask.fromOwner, askerId: ask.askerId, title: frame.title ?? null, part: fields.part, tool: ask.tool, deadline, session: frame.resumeSession ?? null });
  if (!machineSockets.send(machineId, frame)) {
    machines.end(runId, { outcome: "lost", error: "offline", wallMs: 0 });
    return refused("offline");
  }
  return Response.json({ ok: true, runId, deadline, powers });
}

/** A frame for one live run, sent to its machine; refused when the run is not live. */
function toRun(store, runId, frame) {
  const run = store.machines.run(runId);
  if (!run || run.state === "ended") return refused("unknown_run");
  const message = { ...frame, runId };
  const why = invalid("ServerMessage", message);
  if (why !== null) return refused("bad_message", { why });
  return Response.json({ ok: store.machineSockets.send(run.machineId, message) });
}

/**
 * A note-mail line for a whole machine, not one run: a mailbox was joined from a session on it (`mail/deliver.js`).
 * `sent` is false when the machine is offline or gone; the line is in the note either way, which is the record.
 */
function mail(store, fields) {
  store.machineSockets.prune?.();
  const machine = store.machines.get(fields.id);
  if (!machine) return refused("unknown_machine");
  const frame = { type: "mail", ...fields.mail };
  const why = invalid("Mail", frame);
  if (why !== null) return refused("bad_message", { why });
  // Kept first: a send to a socket that died without closing looks fine, and the next hello hands it over again.
  store.machines.holdMail(machine.id, frame);
  return Response.json({ ok: true, sent: store.machineSockets.send(machine.id, frame) });
}

/** How long a sign-in from the app waits for its code, as the runner waits (`sign_in.rs` `CODE_WAIT`), and a little more. */
export const SIGN_IN_WAIT_MS = 16 * 60 * 1000;

function signInId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `si_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The owner signing a coding tool in from the app (`sign_in.rs` on the runner); who may was checked by the gateway
 * (`machines/appRoutes.js`, the computer's own owner only). Without a code: a new sign-in, sent to the runner, which
 * answers with the tool's link. With one: that code, for the sign-in waiting on it, handed straight on. The code is
 * in the frame and nowhere else: not on the machine's row, not in a refusal, not in a log.
 */
function signIn(store, fields) {
  const { machines, machineSockets } = store;
  const machine = machines.get(fields.id);
  if (!machine) return refused("unknown_machine");
  if (typeof fields.code !== "string") {
    if (!(machine.facts?.signIn ?? []).includes(fields.tool)) return refused("not_supported");
    const frame = { type: "signIn", signInId: signInId(), tool: fields.tool };
    if (invalid("ServerMessage", frame) !== null) return refused("bad_message");
    if (!machineSockets.send(machine.id, frame)) return refused("offline");
    return Response.json({ ok: true, machine: shown(store, machines.signIn(machine.id, { id: frame.signInId, tool: frame.tool, state: "starting" })) });
  }
  const held = machine.signIn;
  // A device sign-in (Codex) takes its code on the maker's page, never here.
  const waiting = held && held.id === fields.signInId && held.state === "link" && !held.userCode && machines.now() - held.at < SIGN_IN_WAIT_MS;
  if (!waiting) return refused("sign_in_ended");
  const frame = { type: "signIn", signInId: held.id, tool: held.tool, code: fields.code };
  // Its reason names the field, never the value.
  if (invalid("ServerMessage", frame) !== null) return refused("bad_code");
  if (!machineSockets.send(machine.id, frame)) return refused("offline");
  return Response.json({ ok: true, machine: shown(store, machines.signIn(machine.id, { id: held.id, tool: held.tool, state: "checking", ...(held.url ? { url: held.url } : {}) })) });
}

/** How long an install may be under way before another may start (`install.rs` `INSTALL_WAIT`, and a little more). */
export const INSTALL_WAIT_MS = 21 * 60 * 1000;

/**
 * The owner installing a coding tool from the app (`install.rs` on the runner); who may was checked by the gateway
 * (`machines/appRoutes.js`, the computer's own owner only). The frame names the tool and nothing else: the runner
 * alone decides what it downloads, checks and puts where. One install at a time.
 */
function install(store, fields) {
  const { machines, machineSockets } = store;
  const machine = machines.get(fields.id);
  if (!machine) return refused("unknown_machine");
  if (!(machine.facts?.install ?? []).includes(fields.tool)) return refused("not_supported");
  const held = machine.install;
  if (held && (held.state === "starting" || held.state === "working") && machines.now() - held.at < INSTALL_WAIT_MS) return refused("busy");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const frame = { type: "install", installId: `in_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`, tool: fields.tool };
  if (invalid("ServerMessage", frame) !== null) return refused("bad_message");
  if (!machineSockets.send(machine.id, frame)) return refused("offline");
  return Response.json({ ok: true, machine: shown(store, machines.install(machine.id, { id: frame.installId, tool: frame.tool, state: "starting" })) });
}

/** A `ws.machine.*` call, or null when `op` is not one. */
export async function serveMachineCall(store, op, fields) {
  if (!OPS.has(op)) return null;
  if (!store.machines || !store.machineSockets) return refused("not_served");
  try {
    switch (op) {
      case MACHINE_OPS.ADD:
        return Response.json({ ok: true, machine: shown(store, store.machines.add(fields.machine)) });
      case MACHINE_OPS.LIST:
        store.machineSockets.prune?.();
        return Response.json({ ok: true, machines: store.machines.list().map((machine) => shown(store, machine)) });
      case MACHINE_OPS.MAIL:
        return mail(store, fields);
      case MACHINE_OPS.GET: {
        store.machineSockets.prune?.();
        const machine = store.machines.get(fields.id);
        return machine ? Response.json({ ok: true, machine: shown(store, machine) }) : refused("unknown_machine");
      }
      case MACHINE_OPS.SET: {
        const machine = store.machines.set(fields.id, fields.patch);
        store.machineSockets.rulesChanged(machine.id);
        return Response.json({ ok: true, machine: shown(store, machine) });
      }
      case MACHINE_OPS.REMOVE: {
        store.machineSockets.goodbye(fields.id, fields.reason === "replaced" ? "replaced" : "revoked");
        const ended = store.machines.remove(fields.id);
        return Response.json({ ok: true, ended: ended.map((run) => ({ runId: run.runId, jobId: run.jobId })) });
      }
      case MACHINE_OPS.ASSIGN:
        return assign(store, fields);
      case MACHINE_OPS.DELIVER:
        return toRun(store, fields.runId, { type: "message", messageId: fields.messageId, kind: fields.kind, from: fields.from, text: fields.text, ...(fields.app ? { app: fields.app } : {}), ...(fields.path ? { path: fields.path } : {}), ...(Number.isSafeInteger(fields.at) ? { at: fields.at } : {}) });
      case MACHINE_OPS.INTERRUPT:
        // Only Tex or the person may interrupt; the caller checked who, and this frame carries no authority of its own.
        return toRun(store, fields.runId, { type: "interrupt", messageId: fields.messageId, from: fields.from, text: fields.text, ...(fields.path ? { path: fields.path } : {}) });
      case MACHINE_OPS.CANCEL: {
        const answer = toRun(store, fields.runId, { type: "cancel", reason: fields.reason ?? "stopped" });
        const sent = (await answer.clone().json()).ok === true;
        // An offline machine's run ends here; an online one ends with the runner's result.
        if (!sent && store.machines.run(fields.runId)?.state !== "ended") store.machines.end(fields.runId, { outcome: "cancelled", error: "cancelled while offline" });
        return answer;
      }
      case MACHINE_OPS.RAISE: {
        // "More time today" from the app; who may was checked by the gateway (`machines/appRoutes.js`).
        const machine = store.machines.raise(fields.id, fields.minutes);
        store.machineSockets.rulesChanged(machine.id);
        return Response.json({ ok: true, machine: shown(store, machine) });
      }
      case MACHINE_OPS.ANSWER: {
        // The owner's answer from the app or their 👍 in the chat; who is answering was checked by the gateway (`machines/appRoutes.js`, `machines/groupAsk.js`).
        const answered = store.machines.answer(fields.id, fields.askId, fields.yes === true);
        if (answered === null) return refused("unknown_ask");
        if (answered.state === "yes" && fields.always === true) {
          const machine = store.machines.get(fields.id);
          const rule = machine?.chats[answered.chat];
          if (rule) {
            store.machines.set(fields.id, { chats: { ...machine.chats, [answered.chat]: { ...rule, always: [...rule.always, answered.askerId] } } });
            store.machineSockets.rulesChanged(fields.id);
          }
        }
        return Response.json({ ok: true, ask: answered });
      }
      case MACHINE_OPS.SIGN_IN:
        return signIn(store, fields);
      case MACHINE_OPS.INSTALL:
        return install(store, fields);
      case MACHINE_OPS.RUN: {
        const run = store.machines.run(fields.runId);
        // The computer's name too, so the chat's history says where the work ran.
        return run ? Response.json({ ok: true, run, online: store.machineSockets.online(run.machineId), machineName: store.machines.get(run.machineId)?.name ?? null }) : refused("unknown_run");
      }
    }
  } catch (error) {
    if (error instanceof MachineRefused) return refused(error.code);
    throw error;
  }
  return null;
}
