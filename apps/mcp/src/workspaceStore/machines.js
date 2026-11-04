/**
 * The computers a workspace owns, kept by its workspace object (decided by the
 * owner, 2026-11-03: no object per machine;
 * docs/decisions/texting-assistant/machines.md).
 *
 * A machine is one row here: its name, its owner, its public key, the rules
 * the owner set (folders, coding tools, limits, computer use) and which chats
 * may send it work. Its runs and its daily usage are rows too, so the slot
 * counters survive the object hibernating, and everything exports with the
 * workspace. The control plane keeps only the machine's revocable grant.
 *
 * `admit` is the gateway's half of the double check: whether a job may take a
 * slot on a machine, for this asker, in this chat, now. The runner checks the
 * same rules again on the machine (`machineProtocol.schema.json`, `Rules`),
 * so neither a bug here nor a tampered runner gets past one check.
 */

import protocol from "../../../../packages/shared/src/machineProtocol.cjs";

const { DEFAULT_LIMITS, MAX_LONGEST_RUN_MS, MAX_SLOTS } = protocol;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ws_machines (id TEXT PRIMARY KEY, row TEXT NOT NULL, at INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ws_machine_runs (run TEXT PRIMARY KEY, machine TEXT NOT NULL, job TEXT NOT NULL, chat TEXT NOT NULL, owner INTEGER NOT NULL, state TEXT NOT NULL, row TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ws_machine_runs_live ON ws_machine_runs (machine, state)`,
  // "Ask me first": one ask per job, chat and asker on a machine, waiting for its owner's answer.
  `CREATE TABLE IF NOT EXISTS ws_machine_asks (id TEXT PRIMARY KEY, machine TEXT NOT NULL, chat TEXT NOT NULL, asker TEXT NOT NULL, job TEXT NOT NULL, state TEXT NOT NULL, row TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ws_machine_asks_for ON ws_machine_asks (machine, chat, asker, job)`,
  `CREATE TABLE IF NOT EXISTS ws_machine_usage (machine TEXT NOT NULL, day TEXT NOT NULL, owner_ms INTEGER NOT NULL DEFAULT 0, others_ms INTEGER NOT NULL DEFAULT 0, others_runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (machine, day))`,
];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOLS = new Set(["claude", "codex"]);
/** A run in one of these holds a slot. */
const LIVE = ["assigned", "running"];
/** Ended runs are kept this long, so a job that missed the result can still read it. */
const ENDED_KEPT_MS = 24 * 60 * 60 * 1000;
/** An owner's answer to "Ask me first" holds for the job's day; an unanswered ask is dropped after it. */
const ASK_KEPT_MS = 24 * 60 * 60 * 1000;
/** Usage days kept: a week for the weekly limit, and a margin. */
const USAGE_DAYS_KEPT = 10;

export class MachineRefused extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.code = code;
  }
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The day a time falls on in the owner's time zone, as YYYY-MM-DD; UTC when the zone is unknown. */
export function dayOf(at, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** The last seven days ending on `at`'s day, newest first. */
function weekOf(at, timeZone) {
  const days = new Set();
  for (let back = 0; days.size < 7 && back < 9; back += 1) days.add(dayOf(at - back * 86400000, timeZone));
  return [...days];
}

function clampInt(value, low, high, fallback) {
  return Number.isSafeInteger(value) ? Math.max(low, Math.min(high, value)) : fallback;
}

/** Limits as the owner set them, every field in range; anything missing takes the default. */
export function limitsOf(raw, slotsDefault = DEFAULT_LIMITS.slots) {
  const given = raw && typeof raw === "object" ? raw : {};
  const limits = {
    slots: clampInt(given.slots, 1, MAX_SLOTS, slotsDefault),
    dayMs: clampInt(given.dayMs, 0, 86400000, DEFAULT_LIMITS.dayMs),
    weekMs: clampInt(given.weekMs, 0, 7 * 86400000, DEFAULT_LIMITS.weekMs),
    othersDayMs: clampInt(given.othersDayMs, 0, 86400000, DEFAULT_LIMITS.othersDayMs),
    othersRunsPerDay: clampInt(given.othersRunsPerDay, 0, 1000, DEFAULT_LIMITS.othersRunsPerDay),
    longestRunMs: clampInt(given.longestRunMs, 60000, MAX_LONGEST_RUN_MS, DEFAULT_LIMITS.longestRunMs),
    pauseNearPlanLimit: typeof given.pauseNearPlanLimit === "boolean" ? given.pauseNearPlanLimit : DEFAULT_LIMITS.pauseNearPlanLimit,
    keepOneForOwner: given.keepOneForOwner === true,
  };
  if (Number.isSafeInteger(given.weekTokens) && given.weekTokens >= 0) limits.weekTokens = given.weekTokens;
  if (typeof given.timeZone === "string" && given.timeZone.length <= 64) limits.timeZone = given.timeZone;
  return limits;
}

/** Folders the owner allowed: absolute paths, never `/` or a bare home folder, at most 32. */
export function foldersOf(raw) {
  if (!Array.isArray(raw)) return [];
  const kept = [];
  for (const folder of raw) {
    if (typeof folder !== "string" || folder.length === 0 || folder.length > 1024) continue;
    const absolute = folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder);
    if (!absolute || folder.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(folder)) continue;
    if (/^(\/|[A-Za-z]:[\\/]?|\/home\/[^/]+\/?|\/Users\/[^/]+\/?|\/root\/?)$/.test(folder)) continue;
    if (!kept.includes(folder)) kept.push(folder);
    if (kept.length === 32) break;
  }
  return kept;
}

/** Who may send work from one chat, normalized. The default is the owner alone ("Only me"). */
export function chatRuleOf(raw) {
  const given = raw && typeof raw === "object" ? raw : {};
  const who = given.who === "everyone" ? "everyone" : Array.isArray(given.who) ? [...new Set(given.who.filter((id) => typeof id === "string" && ID.test(id)))].slice(0, 100) : "owner";
  return {
    name: typeof given.name === "string" ? given.name.slice(0, 100) : "",
    who,
    // "Ask me first" is on unless the owner turned it off (design, "Group chats").
    askFirst: given.askFirst !== false,
    always: Array.isArray(given.always) ? [...new Set(given.always.filter((id) => typeof id === "string" && ID.test(id)))].slice(0, 100) : [],
    slots: clampInt(given.slots, 0, MAX_SLOTS, 1),
    network: given.network === true,
    helpers: given.helpers === true,
  };
}

/** The rules the runner enforces locally, from a machine row. */
export function rulesOf(machine, at = Date.now()) {
  return {
    folders: machine.folders,
    tools: machine.tools,
    // Today's raise rides on the day's limit: the runner's copy is a ceiling, and the next rules it gets drop it.
    limits: { ...machine.limits, dayMs: dayLimitOf(machine, at) },
    computerUse: machine.computerUse,
    ...(machine.trustedRepos.length > 0 ? { trustedRepos: machine.trustedRepos } : {}),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The day's limit on a machine: its own, plus the owner's raise when it was given for today ("2 more hours today"). */
export function dayLimitOf(machine, at) {
  const raise = machine.raise;
  return raise && raise.day === dayOf(at, machine.limits.timeZone) ? Math.min(machine.limits.dayMs + raise.extraMs, DAY_MS) : machine.limits.dayMs;
}

const raiseOf = (raw) => (raw && typeof raw === "object" && typeof raw.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.day) && Number.isSafeInteger(raw.extraMs) && raw.extraMs > 0 ? { day: raw.day, extraMs: Math.min(raw.extraMs, DAY_MS) } : null);

function machineOf(raw, previous = null) {
  const given = raw && typeof raw === "object" ? raw : {};
  const base = previous ?? {};
  const pick = (key, fallback) => (given[key] !== undefined ? given[key] : base[key] !== undefined ? base[key] : fallback);
  const slots = pick("slotCounts", null);
  // Mail-only is the pairing's, fixed at add: a device a session paired through its Context connection (`pair_device`).
  const mailOnly = base.mailOnly === true || (previous === null && given.mailOnly === true);
  const tools = mailOnly ? [] : (pick("tools", ["claude", "codex"]) ?? []).filter((tool) => TOOLS.has(tool));
  const chats = {};
  for (const [key, rule] of Object.entries(pick("chats", {}) ?? {}).slice(0, 50)) if (ID.test(key)) chats[key] = chatRuleOf(rule);
  return {
    id: base.id ?? given.id,
    name: String(pick("name", "Computer")).slice(0, 100),
    os: ["macos", "linux", "windows"].includes(pick("os", "linux")) ? pick("os", "linux") : "linux",
    ownerId: base.ownerId ?? given.ownerId,
    publicKey: base.publicKey ?? given.publicKey,
    folders: foldersOf(pick("folders", [])),
    tools: [...new Set(tools)],
    limits: limitsOf(pick("limits", null), slots?.recommended),
    computerUse: pick("computerUse", false) === true,
    trustedRepos: (pick("trustedRepos", []) ?? []).filter((repo) => typeof repo === "string" && repo.length <= 200).slice(0, 100),
    chats,
    goodAt: typeof pick("goodAt", null) === "string" ? pick("goodAt", null).slice(0, 1024) : null,
    facts: pick("facts", null),
    slotCounts: slots,
    // Whether the owner picked the slot count; until they do, the runner's recommended count is used.
    slotsChosen: base.slotsChosen === true || Number.isSafeInteger(given.limits?.slots),
    status: pick("status", null),
    pausedUntil: Number.isSafeInteger(pick("pausedUntil", null)) ? pick("pausedUntil", null) : null,
    seenAt: Number.isSafeInteger(pick("seenAt", null)) ? pick("seenAt", null) : null,
    // Never from the app's settings: only `raise` below sets it, for one day.
    raise: raiseOf(base.raise ?? null),
    ...(mailOnly ? { mailOnly: true } : {}),
    // When a mail-only device leaves on its own, whatever else happens; fixed at add.
    ...(mailOnly && Number.isSafeInteger(base.expiresAt ?? given.expiresAt) ? { expiresAt: base.expiresAt ?? given.expiresAt } : {}),
  };
}

/** Settings an owner or editor may change from the app; everything else is the pairing's or the runner's. */
const SETTABLE = new Set(["name", "folders", "tools", "limits", "computerUse", "trustedRepos", "chats", "goodAt"]);
/** A mail-only device's settings: its name only. Nothing an owner sets turns one into a computer Tex sends jobs to. */
const MAIL_ONLY_SETTABLE = new Set(["name"]);
/** A mail-only device that has been offline this long leaves on its own: its session is gone. */
export const MAIL_ONLY_OFFLINE_MS = 15 * 60 * 1000;

/**
 * @param {{exec: Function}} sql
 * @param {{now?: () => number}} [deps]
 */
export function workspaceMachines(sql, deps = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const now = deps.now ?? (() => Date.now());

  const get = (id) => {
    if (typeof id !== "string" || !ID.test(id)) return null;
    const row = all(sql.exec("SELECT row FROM ws_machines WHERE id = ? AND gone = 0", id))[0];
    return row ? JSON.parse(row.row) : null;
  };
  const save = (machine) => {
    sql.exec("INSERT INTO ws_machines (id, row, at, gone) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET row = excluded.row, at = excluded.at, gone = 0", machine.id, JSON.stringify(machine), now());
    return machine;
  };
  const runOf = (row) => (row ? { ...JSON.parse(row.row), state: row.state } : null);
  const run = (runId) => (typeof runId === "string" && ID.test(runId) ? runOf(all(sql.exec("SELECT row, state FROM ws_machine_runs WHERE run = ?", runId))[0]) : null);
  const liveRuns = (machineId) => all(sql.exec(`SELECT row, state FROM ws_machine_runs WHERE machine = ? AND state IN (${LIVE.map(() => "?").join(", ")})`, machineId, ...LIVE)).map(runOf);
  const usage = (machineId, days) => {
    const rows = all(sql.exec(`SELECT day, owner_ms, others_ms, others_runs FROM ws_machine_usage WHERE machine = ? AND day IN (${days.map(() => "?").join(", ")})`, machineId, ...days));
    return rows.reduce((sum, row) => ({ ownerMs: sum.ownerMs + row.owner_ms, othersMs: sum.othersMs + row.others_ms, othersRuns: sum.othersRuns + row.others_runs }), { ownerMs: 0, othersMs: 0, othersRuns: 0 });
  };
  const addUsage = (machineId, timeZone, fields) => {
    const day = dayOf(now(), timeZone);
    sql.exec(
      "INSERT INTO ws_machine_usage (machine, day, owner_ms, others_ms, others_runs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(machine, day) DO UPDATE SET owner_ms = owner_ms + excluded.owner_ms, others_ms = others_ms + excluded.others_ms, others_runs = others_runs + excluded.others_runs",
      machineId, day, fields.ownerMs ?? 0, fields.othersMs ?? 0, fields.othersRuns ?? 0,
    );
  };

  return {
    now,
    get,
    run,
    liveRuns,
    list: () => all(sql.exec("SELECT row FROM ws_machines WHERE gone = 0 ORDER BY id")).map((row) => JSON.parse(row.row)),

    /** A machine the control plane just paired or registered. Its owner, key and id never change afterwards. */
    add(fields) {
      if (!fields || !ID.test(fields.id ?? "") || !ID.test(fields.ownerId ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(fields.publicKey ?? "")) {
        throw new MachineRefused("bad_machine");
      }
      const existing = get(fields.id);
      if (existing && (existing.ownerId !== fields.ownerId || existing.publicKey !== fields.publicKey)) throw new MachineRefused("bad_machine", "a machine's owner and key never change");
      // A new machine counts as seen when it is added, so one that never connects still leaves on time.
      return save(machineOf(existing ? fields : { ...fields, seenAt: now() }, existing));
    },

    /** The owner's settings from the app. Unknown keys are refused, not ignored. */
    set(id, patch) {
      const machine = get(id);
      if (!machine) throw new MachineRefused("unknown_machine");
      const settable = machine.mailOnly === true ? MAIL_ONLY_SETTABLE : SETTABLE;
      for (const key of Object.keys(patch ?? {})) if (!settable.has(key)) throw new MachineRefused("bad_setting", key);
      return save(machineOf(patch, machine));
    },

    /** The owner's "more time today": added to today's limit, gone tomorrow. `minutes` from 1 to a day. */
    raise(id, minutes) {
      const machine = get(id);
      if (!machine) throw new MachineRefused("unknown_machine");
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new MachineRefused("bad_setting", "minutes");
      const day = dayOf(now(), machine.limits.timeZone);
      const already = machine.raise?.day === day ? machine.raise.extraMs : 0;
      return save({ ...machine, raise: { day, extraMs: Math.min(already + minutes * 60_000, DAY_MS) } });
    },

    /** What the runner reported: facts, slot counts, status. */
    seen(id, fields) {
      const machine = get(id);
      if (!machine) return null;
      const next = { ...machine, seenAt: now() };
      if (fields.facts) next.facts = fields.facts;
      if (fields.slotCounts) {
        // The first report sizes the slots at the recommended count; a later one only caps them at the most.
        if (!machine.slotsChosen) next.limits = { ...machine.limits, slots: fields.slotCounts.recommended };
        next.limits = { ...next.limits, slots: Math.min(next.limits.slots, fields.slotCounts.most) };
        next.slotCounts = fields.slotCounts;
      }
      if (fields.status) next.status = fields.status;
      if (fields.pausedUntil !== undefined) next.pausedUntil = fields.pausedUntil;
      return save(next);
    },

    /** Disconnected: the row is kept as a tombstone, its live runs end. */
    remove(id) {
      const ended = liveRuns(id);
      for (const held of ended) this.end(held.runId, { outcome: "cancelled", error: "machine removed" });
      sql.exec("UPDATE ws_machines SET gone = 1, at = ? WHERE id = ?", now(), id);
      return ended;
    },

    /**
     * Whether a job may take a slot now. Null when it may; otherwise the code that held.
     * `ask` is `{chat, fromOwner, askerId, tool, folder, approved?}`; `online` whether the runner is connected.
     */
    admit(id, ask, online) {
      const machine = get(id);
      if (!machine) return { code: "unknown_machine" };
      // A mail-only device gets mail and never a job, whoever asks (owner, 2026-11-04).
      if (machine.mailOnly === true) return { code: "mail_only" };
      const rule = machine.chats[ask.chat] ?? null;
      if (!ask.fromOwner) {
        if (!rule) return { code: "rule" };
        if (rule.who === "owner" || (Array.isArray(rule.who) && !rule.who.includes(ask.askerId))) return { code: "rule" };
        if (rule.askFirst && !rule.always.includes(ask.askerId) && ask.approved !== true) return { code: "ask_first" };
      }
      if (!online) return { code: "offline" };
      if (machine.status && machine.status.ready === false) return { code: "not_ready" };
      if (machine.pausedUntil !== null && machine.pausedUntil > now()) return { code: "plan_limit", until: machine.pausedUntil };
      if (!machine.tools.includes(ask.tool)) return { code: "tool" };
      if (!machine.folders.includes(ask.folder)) return { code: "folder" };
      const live = liveRuns(id);
      const { limits } = machine;
      if (live.length >= limits.slots) return { code: "busy" };
      if (!ask.fromOwner) {
        if (limits.keepOneForOwner && live.length >= limits.slots - 1) return { code: "busy" };
        if (live.filter((held) => held.chat === ask.chat && !held.fromOwner).length >= rule.slots) return { code: "busy" };
      }
      const today = usage(id, [dayOf(now(), limits.timeZone)]);
      if (today.ownerMs + today.othersMs >= dayLimitOf(machine, now())) return { code: "limit_day" };
      const week = usage(id, weekOf(now(), limits.timeZone));
      if (week.ownerMs + week.othersMs >= limits.weekMs) return { code: "limit_week" };
      if (!ask.fromOwner && (today.othersMs >= limits.othersDayMs || today.othersRuns >= limits.othersRunsPerDay)) return { code: "limit_others" };
      return null;
    },

    /** What a run started now on behalf of `ask` may have: others' runs never get computer use, and get network and helpers only if the chat allows. */
    powers(id, ask) {
      const machine = get(id);
      const rule = machine?.chats[ask.chat] ?? chatRuleOf(null);
      return ask.fromOwner
        ? { computerUse: machine?.computerUse === true && ask.computerUse === true, network: true, helpers: true }
        : { computerUse: false, network: rule.network, helpers: rule.helpers };
    },

    /** Records a run that took a slot. Throws when the run id is taken. */
    start(fields) {
      if (run(fields.runId)) throw new MachineRefused("run_taken");
      const machine = get(fields.machineId);
      const row = { ...fields, startedAt: now(), lastStep: 0, wallMs: 0, steps: [] };
      sql.exec("INSERT INTO ws_machine_runs (run, machine, job, chat, owner, state, row, at) VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?)", fields.runId, fields.machineId, fields.jobId, fields.chat, fields.fromOwner ? 1 : 0, JSON.stringify(row), now());
      if (!fields.fromOwner) addUsage(fields.machineId, machine?.limits.timeZone, { othersRuns: 1 });
      return row;
    },

    /** Changes a live run's row; the state only moves forward. */
    update(runId, patch, state) {
      const held = run(runId);
      if (!held || held.state === "ended") return null;
      const { state: _state, ...row } = { ...held, ...patch };
      sql.exec("UPDATE ws_machine_runs SET row = ?, state = ?, at = ? WHERE run = ?", JSON.stringify(row), state ?? held.state, now(), runId);
      return { ...row, state: state ?? held.state };
    },

    /** A run ended: its time is counted against the machine, once. */
    end(runId, result) {
      const held = run(runId);
      if (!held || held.state === "ended") return null;
      const machine = get(held.machineId);
      const wallMs = Number.isSafeInteger(result.wallMs) ? Math.max(0, result.wallMs) : Math.max(0, now() - held.startedAt);
      addUsage(held.machineId, machine?.limits.timeZone, held.fromOwner ? { ownerMs: wallMs } : { othersMs: wallMs });
      return this.update(runId, { result: { ...result, wallMs }, endedAt: now(), wallMs }, "ended");
    },

    /** How much each machine has used today and this week, for the machine page. */
    used(id) {
      const machine = get(id);
      if (!machine) return null;
      const today = usage(id, [dayOf(now(), machine.limits.timeZone)]);
      const week = usage(id, weekOf(now(), machine.limits.timeZone));
      return { todayMs: today.ownerMs + today.othersMs, othersTodayMs: today.othersMs, othersRunsToday: today.othersRuns, weekMs: week.ownerMs + week.othersMs };
    },

    /**
     * "Ask me first": the ask for this job, chat and asker on a machine, made now if there is none.
     * `{id, state}`, its state `pending`, `yes` or `no` until the owner answers otherwise.
     */
    ask(machineId, fields) {
      const found = all(sql.exec("SELECT id, state, row, at FROM ws_machine_asks WHERE machine = ? AND chat = ? AND asker = ? AND job = ? AND at > ? ORDER BY at DESC LIMIT 1", machineId, fields.chat, fields.askerId, fields.jobId, now() - ASK_KEPT_MS))[0];
      if (found) return { ...JSON.parse(found.row), id: found.id, state: found.state };
      const id = `ask_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const row = { machineId, chat: fields.chat, askerId: fields.askerId, jobId: fields.jobId, title: typeof fields.title === "string" ? fields.title.slice(0, 200) : null, chatName: typeof fields.chatName === "string" ? fields.chatName.slice(0, 100) : null, ...(typeof fields.chatKey === "string" && /^[0-9a-f]{64}$/.test(fields.chatKey) ? { chatKey: fields.chatKey } : {}), askedAt: now() };
      sql.exec("INSERT INTO ws_machine_asks (id, machine, chat, asker, job, state, row, at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)", id, machineId, fields.chat, fields.askerId, fields.jobId, JSON.stringify(row), now());
      // `fresh`: made just now, so the chat is asked once (`machines/groupAsk.js`), never at each look.
      return { ...row, id, state: "pending", fresh: true };
    },

    /** Whether the owner said yes to this job, chat and asker on a machine, within the day. */
    approved(machineId, fields) {
      return all(sql.exec("SELECT 1 AS yes FROM ws_machine_asks WHERE machine = ? AND chat = ? AND asker = ? AND job = ? AND state = 'yes' AND at > ? LIMIT 1", machineId, fields.chat, fields.askerId, fields.jobId, now() - ASK_KEPT_MS)).length > 0;
    },

    /** The owner's answer to one ask on their machine; null when there is no such ask waiting. */
    answer(machineId, askId, yes) {
      if (typeof askId !== "string" || !ID.test(askId)) return null;
      const found = all(sql.exec("SELECT row, state FROM ws_machine_asks WHERE id = ? AND machine = ? AND at > ?", askId, machineId, now() - ASK_KEPT_MS))[0];
      if (!found || found.state !== "pending") return null;
      const state = yes === true ? "yes" : "no";
      sql.exec("UPDATE ws_machine_asks SET state = ? WHERE id = ?", state, askId);
      return { ...JSON.parse(found.row), id: askId, state };
    },

    /** The asks on a machine still waiting for its owner, newest first. */
    pendingAsks(machineId) {
      return all(sql.exec("SELECT id, row FROM ws_machine_asks WHERE machine = ? AND state = 'pending' AND at > ? ORDER BY at DESC LIMIT 20", machineId, now() - ASK_KEPT_MS)).map((found) => ({ ...JSON.parse(found.row), id: found.id }));
    },

    /**
     * Mail-only devices whose time is up, or that have been offline `MAIL_ONLY_OFFLINE_MS` (their session is gone):
     * the ids to remove. `online(id)` says whether a device's runner is connected now; `seenAt` is when it was last
     * heard from or went offline.
     */
    leaving(online) {
      const at = now();
      return this.list()
        .filter((machine) => machine.mailOnly === true)
        .filter((machine) => (Number.isSafeInteger(machine.expiresAt) && machine.expiresAt <= at) || (!online(machine.id) && at - (machine.seenAt ?? at) >= MAIL_ONLY_OFFLINE_MS))
        .map((machine) => machine.id);
    },

    /** Old ended runs and old usage days, dropped. */
    sweep() {
      sql.exec("DELETE FROM ws_machine_asks WHERE at < ?", now() - ASK_KEPT_MS);
      sql.exec("DELETE FROM ws_machine_runs WHERE state = 'ended' AND at < ?", now() - ENDED_KEPT_MS);
      sql.exec("DELETE FROM ws_machine_usage WHERE day < ?", dayOf(now() - USAGE_DAYS_KEPT * 86400000, "UTC"));
    },
  };
}
