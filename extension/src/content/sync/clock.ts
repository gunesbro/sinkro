const MAX_SAMPLES = 5;

type Sample = { roundTrip: number; offset: number };

/**
 * Estimates server time from ping/pong round trips. The fastest recent round trip is
 * the one least distorted by queueing, so its offset wins. Old samples age out, which
 * lets the estimate follow a changed network or a corrected system clock.
 */
export class ServerClock {
  private samples: Sample[] = [];

  addSample(clientTime: number, serverTime: number, receivedAt: number): void {
    const roundTrip = receivedAt - clientTime;
    if (roundTrip < 0) return;

    this.samples.push({ roundTrip, offset: serverTime - (clientTime + receivedAt) / 2 });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Milliseconds to add to the local clock to get server time. */
  get offset(): number {
    let best: Sample | null = null;
    for (const sample of this.samples) {
      if (!best || sample.roundTrip < best.roundTrip) best = sample;
    }
    return best?.offset ?? 0;
  }
}
