import { DurableObject } from "cloudflare:workers";

const MAX_ROOMS = 10;
const WINDOW_MS = 60_000;

type CreationWindow = { startedAt: number; count: number };

/**
 * Counts room creation for one address, named by a hash of it. Kept in storage because
 * an idle object leaves memory within seconds, which would let bursts reset the count.
 * The alarm deletes the record when the window ends, so nothing outlives a minute.
 */
export class CreationLimiter extends DurableObject {
  async allow(): Promise<boolean> {
    const now = Date.now();
    const current = await this.ctx.storage.get<CreationWindow>("window");

    if (!current || now - current.startedAt >= WINDOW_MS) {
      await this.ctx.storage.put<CreationWindow>("window", { startedAt: now, count: 1 });
      await this.ctx.storage.setAlarm(now + WINDOW_MS);
      return true;
    }
    if (current.count >= MAX_ROOMS) return false;

    await this.ctx.storage.put<CreationWindow>("window", {
      ...current,
      count: current.count + 1,
    });
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
