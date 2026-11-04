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
    return refused(waiting.state === "no" ? "declined" : "ask_first", { askId: waiting.id });
  }
  if (held !== null) return refused(held.code, held.until ? { until: held.until } : {});
  const powers = machines.powers(machineId, ask);
  const now = machines.now();
  // A part never runs past the machine's longest job, whatever the caller asked.
  const deadline = Math.min(Number.isSafeInteger(fields.deadline) ? fields.deadline : now + machine.limits.longestRunMs, now + machine.limits.longestRunMs);
  // Only the owner's own asks may run with the tool's full permissions.
  const permission = fields.permission === "full" && !ask.fromOwner ? "edits" : fields.permission;
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

/** A `ws.machine.*` call, or null when `op` is not one. */
export async function serveMachineCall(store, op, fields) {
  if (!OPS.has(op)) return null;
  if (!store.machines || !store.machineSockets) return refused("not_served");
  try {
    switch (op) {
      case MACHINE_OPS.ADD:
        return Response.json({ ok: true, machine: shown(store, store.machines.add(fields.machine)) });
      case MACHINE_OPS.LIST:
        return Response.json({ ok: true, machines: store.machines.list().map((machine) => shown(store, machine)) });
      case MACHINE_OPS.GET: {
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
        // The owner's answer from the app; who is answering was checked by the gateway (`machines/appRoutes.js`).
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
      case MACHINE_OPS.RUN: {
        const run = store.machines.run(fields.runId);
        return run ? Response.json({ ok: true, run, online: store.machineSockets.online(run.machineId) }) : refused("unknown_run");
      }
    }
  } catch (error) {
    if (error instanceof MachineRefused) return refused(error.code);
    throw error;
  }
  return null;
}
