/** Following goes through a new page, so the room hears the old one go before the new one come. */
const ARRIVAL_WAIT_MS = 15_000;

/**
 * Says when everyone who wasn't on the room's video is, so the viewer can be told "everyone's
 * here". The count of others away also drops when one leaves the room, or when one brings
 * everyone to their own video instead, and neither of those is anyone arriving.
 */
export class Arrivals {
  /** How many were in the room while someone was away, and until when to wait for them. */
  private waiting: { peers: number; until: number } | null = null;
  private peers = 0;
  private othersAway = 0;

  constructor(
    private readonly options: {
      onEveryoneHere: () => void;
      /** Whether this viewer is on the room's video, without which nobody arrives where they are. */
      isHere: () => boolean;
      now?: () => number;
    },
  ) {}

  setPeers(count: number): void {
    this.peers = count;
    this.check();
  }

  setOthersAway(count: number): void {
    const now = this.options.now?.() ?? Date.now();
    if (count > 0) {
      this.waiting = {
        peers: Math.max(this.peers, this.waiting?.peers ?? 0),
        until: Number.POSITIVE_INFINITY,
      };
    } else if (this.waiting) {
      this.waiting.until = now + ARRIVAL_WAIT_MS;
    }
    this.othersAway = count;
    this.check();
  }

  /** The room's video changed, so whoever was away from the old one hasn't arrived anywhere. */
  roomMoved(): void {
    this.waiting = null;
  }

  private check(): void {
    if (!this.waiting) return;
    const now = this.options.now?.() ?? Date.now();
    if (now > this.waiting.until) {
      this.waiting = null;
    } else if (this.othersAway === 0 && this.peers >= this.waiting.peers) {
      this.waiting = null;
      if (this.options.isHere()) this.options.onEveryoneHere();
    }
  }
}
