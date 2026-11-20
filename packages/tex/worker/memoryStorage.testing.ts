/** An in-memory `InboxStorage` for tests: a Durable Object's storage without the runtime. */
import type { InboxStorage } from "./inbox";

export class MemoryStorage implements InboxStorage {
  data = new Map<string, unknown>();
  alarms: number[] = [];
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix }: { prefix: string }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
  /** The one alarm set, as a Durable Object has one: each `setAlarm` replaces it. */
  alarm: number | null = null;
  async setAlarm(at: number) {
    this.alarms.push(at);
    this.alarm = at;
  }
}

/** A storage that also answers `getAlarm`, for tests of which alarm is kept; the alarm "fires" when `fire` is called. */
export class AlarmStorage extends MemoryStorage {
  async getAlarm() {
    return this.alarm;
  }
  fire() {
    this.alarm = null;
  }
}
