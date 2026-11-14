/**
 * An in-memory Durable Object storage for `TexChat` tests: the KV methods the object uses (`get`, `put`, `delete`,
 * `list({prefix})` in key order, `setAlarm`, `getAlarm`), with the alarm held the way the runtime holds one, and a
 * state whose `blockConcurrencyWhile` runs its callback. `fire` stands in for the runtime firing the alarm.
 */

export class MemoryChatStorage {
  data = new Map();
  alarm = null;
  alarms = [];

  async get(key) {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }

  async put(key, value) {
    this.data.set(key, structuredClone(value));
  }

  async delete(key) {
    return this.data.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key))]));
  }

  async setAlarm(at) {
    this.alarm = at;
    this.alarms.push(at);
  }

  async getAlarm() {
    return this.alarm;
  }

  /** The runtime fired the alarm: it is no longer set. */
  fire() {
    this.alarm = null;
  }
}

/** A Durable Object state over a fresh `MemoryChatStorage`. */
export function chatState() {
  const storage = new MemoryChatStorage();
  return { storage, blockConcurrencyWhile: (run) => run() };
}
