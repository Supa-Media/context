/**
 * The Durable Object behind `BROWSER_USE_LEDGER`: one for the whole Worker,
 * named `browser-use`. Spend changes are exclusive, so two fallbacks cannot
 * both read a balance under the cap and both start.
 */

import { DurableObject } from "cloudflare:workers";
import { BrowseLedger, type OwnedSession } from "./browserUseLedger";

export class BrowserUseLedger extends DurableObject {
  private book = new BrowseLedger(this.ctx.storage);

  async spent() {
    return await this.book.spent();
  }

  async addSpend(usd: number) {
    return await this.ctx.blockConcurrencyWhile(() => this.book.addSpend(usd));
  }

  async record(row: unknown) {
    return await this.ctx.blockConcurrencyWhile(() => this.book.record(row));
  }

  async summary() {
    return await this.book.summary();
  }

  async remember(owner: string, session: OwnedSession) {
    return await this.ctx.blockConcurrencyWhile(() => this.book.remember(owner, session));
  }

  async recall(owner: string) {
    return await this.book.recall(owner);
  }

  async forget(owner: string) {
    return await this.ctx.blockConcurrencyWhile(() => this.book.forget(owner));
  }
}
