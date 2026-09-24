/**
 * `MeetingsController`'s persistence half: writing a record to the store,
 * debounced, and the drain that follows a `flush`.
 *
 * Split out of `controller.ts` the same way `lifecycle.ts` is — see its
 * header for the mechanism (`applyMixins`, `controller/shape.ts`) and the
 * guarantee (no behaviour change, only file location).
 */
import type { MeetingsControllerShape } from "./shape";
import { saveMeeting } from "../local";
import type { MeetingRecord } from "../record";
import { isLive } from "../session";
import { PERSIST_DEBOUNCE_MS } from "./types";

export class PersistenceMixin {

  put(this: MeetingsControllerShape, record: MeetingRecord, options: { immediate: boolean }): void {
    const records = [record, ...this.snapshot.records.filter((r) => r.session.id !== record.session.id)]
      .sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt));
    this.set({
      ...this.snapshot,
      records,
      live: records.find((r) => isLive(r.session.state)) ?? null,
    });

    if (options.immediate) {
      this.cancelPersist(record.session.id);
      void this.persist(record);
      return;
    }
    this.schedulePersist(record);
  }

  schedulePersist(this: MeetingsControllerShape, record: MeetingRecord): void {
    const config = this.require();
    this.cancelPersist(record.session.id);
    const timer = setTimeout(() => {
      this.persistTimers.delete(record.session.id);
      const latest = this.find(record.session.id);
      if (latest !== undefined) void this.persist(latest);
    }, config.persistDebounceMs ?? PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(record.session.id, timer);
  }

  /** Write a pending record down now, e.g. because the meeting just ended. */
  flush(this: MeetingsControllerShape, meetingId: string): void {
    const record = this.find(meetingId);
    if (record === undefined) return;
    this.cancelPersist(meetingId);
    void this.persist(record);
  }

  cancelPersist(this: MeetingsControllerShape, meetingId: string): void {
    const timer = this.persistTimers.get(meetingId);
    if (timer !== undefined) clearTimeout(timer);
    this.persistTimers.delete(meetingId);
  }

  async persist(this: MeetingsControllerShape, record: MeetingRecord): Promise<void> {
    const config = this.config;
    if (config === null) return;
    const outcome = await saveMeeting(config.store, record, this.epoch);
    if (outcome.persisted) return;
    /*
      Idempotent on purpose. This runs on every write — which is every keystroke
      — and `set` notifies every subscriber, so a version that reassigned the
      snapshot each time would re-render the whole app once per character on
      exactly the devices least able to afford it.
    */
    const reason = outcome.reason ?? this.snapshot.durabilityReason;
    if (!this.snapshot.durable && this.snapshot.durabilityReason === reason) return;
    this.set({ ...this.snapshot, durable: false, durabilityReason: reason });
  }
}
