/**
 * What a Tex Durable Object keeps and answers, apart from where it lives: its
 * notes (`objects.js`), the chat's ledger (`ledger.js`), the Tex page's
 * sockets and views (`pageLive.js`, `pageViews.js`) and the routine alarms
 * (`alarms.js`), over one Durable Object's state.
 *
 * Two objects host it. A group chat's own `TexStore` (`texStore.js`), and a
 * person's workspace object (`workspaceStore/texHost.js`), which keeps its
 * person's Tex beside the workspace's notes in the same SQLite (decided by the
 * owner, 2026-11-02: "this all lives in 1 durable object";
 * `docs/decisions/texting-assistant/tex-durable-objects.md`). Each host
 * decides who may call; nothing here decides access.
 */

import { cancel, clearAlarms, due, nextAt, retry, schedule, settle } from "./alarms.js";
import { DEFAULT_TABLES, texObjects } from "./objects.js";
import { texLedger } from "./ledger.js";
import { PAGE_LIVE_PATH, pageLive } from "./pageLive.js";
import { logChatOf, pageViews, sectionsForKinds } from "./pageViews.js";
import { serveTexStore } from "./wire.js";
import { writeLocks } from "./writeLock.js";

/** How long a routine that could not be handed on waits before it is tried again. */
export const RETRY_MS = 60 * 1000;
const PAGE_TAG = "page";

export class TexEngine {
  /**
   * @param {object} state the Durable Object's state (`storage.sql`, `setAlarm`, `deleteAlarm`, sockets)
   * @param {object} env the Worker's bindings
   * @param {{dispatch: Function, now?: () => number, pageDeps?: object, tables?: {objects: string, chunks: string}, guard?: () => void, otherWake?: () => (number|null)}} options
   *   `otherWake` is the host's own next alarm, if it has one: the object has one runtime alarm, armed at the earliest.
   */
  constructor(state, env, { dispatch, now = Date.now, pageDeps = {}, tables = DEFAULT_TABLES, guard = () => {}, otherWake = () => null }) {
    this.state = state;
    this.env = env;
    this.dispatch = dispatch;
    this.now = now;
    this.pageDeps = pageDeps;
    this.tables = tables;
    this.guard = guard;
    this.otherWake = otherWake;
    this.objects = null;
    this.timers = null;
    // A group chat's write lock, in memory only (`writeLock.js`).
    this.locks = writeLocks(now);
  }

  /** The notes, ledger, page and alarms, built on first use. */
  ready() {
    if (this.objects !== null) return this;
    const sql = this.state.storage.sql;
    const guard = this.guard;
    this.objects = texObjects(sql, { now: this.now, guard, tables: this.tables });
    // The chat's one record of everything that happened (`ledger.js`), beside the notes.
    this.objects.ledger = texLedger(sql, { now: this.now, guard });
    // The chat's Tex page: the open pages' sockets (`pageLive.js`), and its records as views of the chat's one log
    // (`pageViews.js`), which pushes what changed to an open page on every append.
    this.objects.records = pageViews(() => this.objects.ledger);
    this.page = pageLive(this.state, sql, this.env, { now: this.now, waitingMail: (chat) => this.objects.records.waiting(logChatOf(chat)), ...this.pageDeps });
    this.live = { changed: (sections) => this.page.changed(sections) };
    this.objects.ledgerChanged = (kinds) => this.live.changed(sectionsForKinds(kinds));
    this.timers = {
      schedule: (alarm) => {
        guard();
        const set = schedule(sql, alarm ?? {});
        this.arm();
        return set;
      },
      cancel: (id) => {
        guard();
        cancel(sql, id);
        this.arm();
      },
    };
    return this;
  }

  /** Sets the runtime alarm at the earliest routine, open page's poll or host wake, or clears it when there is none. */
  arm() {
    this.ready();
    const times = [nextAt(this.state.storage.sql), this.page.pollAt(), this.otherWake()].filter((at) => typeof at === "number");
    if (times.length === 0) this.state.storage.deleteAlarm();
    else this.state.storage.setAlarm(Math.min(...times));
  }

  /** One call, after the host has decided it may be answered here. `body` is its bytes, already read. */
  async serve(request, body) {
    this.ready();
    // An open Tex page's socket, from the gateway, which has checked who is asking (`http/texPage/live.js`).
    if (new URL(request.url).pathname === PAGE_LIVE_PATH && (request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const answer = this.page.accept(request);
      this.arm();
      return answer;
    }
    const fresh = new Request(request.url, { method: request.method, headers: request.headers, body });
    const answer = await serveTexStore(this.objects, fresh, this.timers, this.live, this.locks);
    return answer;
  }

  /** The open pages' sockets closed and their state cleared (a move away). */
  wipePage() {
    this.ready();
    this.page.wipe();
  }

  /** After a wipe: the open pages closed and the routine alarms gone with the notes they ran. */
  wiped() {
    this.wipePage();
    clearAlarms(this.state.storage.sql);
    this.arm();
  }

  /**
   * The runtime alarm fired: an open page's poll, then each due routine, one
   * after another. One handed on answers when it next runs and is kept for
   * that time; one that answers none is removed; one that could not be handed
   * on waits `RETRY_MS`. Nothing is ever armed at a time already past.
   */
  async runDue() {
    this.ready();
    const sql = this.state.storage.sql;
    const started = this.now();
    // An open page's jobs, read again when due; a failure waits for the next one and never stops a routine.
    const pollAt = this.page.pollAt();
    if (pollAt !== null && pollAt <= started) {
      try {
        await this.page.poll();
      } catch {
        // Polled again below, by `arm`.
      }
    }
    for (const routine of due(sql, started)) {
      let answer = null;
      try {
        answer = await this.dispatch(routine);
      } catch {
        answer = null;
      }
      if (answer === null) retry(sql, routine, started + RETRY_MS);
      else if (typeof answer.next === "number") retry(sql, routine, answer.next);
      else settle(sql, routine.id, routine.at);
    }
    this.arm();
  }

  /** Whether `ws` is a Tex page's socket. */
  owns(ws) {
    if (typeof this.state.getTags === "function") {
      try {
        return this.state.getTags(ws).includes(PAGE_TAG);
      } catch {
        return false;
      }
    }
    return typeof this.state.getWebSockets === "function" && this.state.getWebSockets(PAGE_TAG).includes(ws);
  }

  message(ws, raw) {
    this.ready();
    this.page.message(ws, raw);
  }
}
