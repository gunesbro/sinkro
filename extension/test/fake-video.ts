import type { SyncedVideo } from "../src/content/sync/engine";

/**
 * Behaves like HTMLMediaElement where the engine can tell: properties change at once
 * and events follow asynchronously. `user*` methods act as the viewer would, while the
 * plain properties and methods are what the engine itself calls.
 */
export class FakeVideo extends EventTarget {
  position = 0;
  duration = 3600;
  paused = true;
  ended = false;
  isConnected = true;
  seeking = false;
  readyState = 4;
  autoplayAllowed = true;
  /** False for something like a live stream: a seek runs, but lands where it started. */
  seekable = true;
  seekDelayMs = 0;
  private seekId = 0;
  playCalls = 0;
  seekCalls = 0;
  private rate = 1;

  get currentTime(): number {
    return this.position;
  }

  set currentTime(value: number) {
    this.seekCalls += 1;
    this.moveTo(value);
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(value: number) {
    this.rate = value;
    this.emit("ratechange");
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (!this.autoplayAllowed) {
      return Promise.reject(new DOMException("Blocked", "NotAllowedError"));
    }
    this.paused = false;
    this.ended = false;
    this.emit("play");
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    // Browsers queue timeupdate ahead of pause, so scripts can see one before the other.
    this.emit("timeupdate");
    this.emit("pause");
  }

  userPlay(): void {
    this.autoplayAllowed = true;
    void this.play();
  }

  userSeek(position: number): void {
    this.moveTo(position);
  }

  userSetRate(rate: number): void {
    this.playbackRate = rate;
  }

  /** The player reloads the element: what's in flight is dropped, and pause doesn't fire. */
  reload(): void {
    this.seekId += 1;
    this.seeking = false;
    this.paused = true;
    this.emit("emptied");
  }

  /** Taken out of the page, which pauses it without anyone asking. */
  removeFromPage(): void {
    this.isConnected = false;
    this.pause();
  }

  /** The video plays to its end, which pauses it without anyone asking. */
  reachEnd(): void {
    this.position = this.duration;
    this.ended = true;
    this.paused = true;
    this.emit("pause");
    this.emit("ended");
  }

  asVideo(): SyncedVideo {
    return this as unknown as SyncedVideo;
  }

  private moveTo(position: number): void {
    if (this.seekable) this.position = position;
    this.ended = false;
    this.seeking = true;
    this.emit("seeking");
    // A new seek aborts one in flight, which then never reports seeked.
    this.seekId += 1;
    const id = this.seekId;
    const finish = () => {
      if (id !== this.seekId) return;
      this.seeking = false;
      this.emit("seeked");
    };
    if (this.seekDelayMs > 0) setTimeout(finish, this.seekDelayMs);
    else queueMicrotask(finish);
  }

  private emit(type: string): void {
    queueMicrotask(() => this.dispatchEvent(new Event(type)));
  }
}
