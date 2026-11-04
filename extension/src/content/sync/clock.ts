const MAX_SAMPLES = 7;
/** Round trips within twice the fastest, plus this, count as equally trustworthy. */
const SIMILAR_ROUND_TRIP_SLACK_MS = 10;

type Sample = { roundTrip: number; offset: number };

/**
 * Estimates server time from ping/pong round trips. A slow round trip was probably
 * queued somewhere, so only the fastest ones count, and taking their median means one
 * odd reading can't move the estimate. Old samples age out, which lets it follow a
 * changed network or a corrected system clock.
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
    const fastest = Math.min(...this.samples.map((sample) => sample.roundTrip));
    const limit = fastest * 2 + SIMILAR_ROUND_TRIP_SLACK_MS;
    const offsets = this.samples
      .filter((sample) => sample.roundTrip <= limit)
      .map((sample) => sample.offset)
      .sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)] ?? 0;
  }
}
