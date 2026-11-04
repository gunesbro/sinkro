import { ACTIVITY_EVENT } from "./activity";

const FULL_SCAN_DELAY_MS = 300;
const MEDIA_EVENTS = ["play", "playing", "loadedmetadata"];

type Root = Document | ShadowRoot;

const ownElements = new WeakSet<Element>();

/** Keeps discovery out of our own UI, whose updates would otherwise look like page changes. */
export function markOwnElement(element: Element): void {
  ownElements.add(element);
}

/** Firefox exposes this on the element, for content scripts only. */
type WithFirefoxShadowAccess = HTMLElement & { openOrClosedShadowRoot?: () => ShadowRoot | null };

/**
 * Reaches closed shadow roots too. An attachShadow hook wouldn't do: custom elements
 * usually attach in their constructor, before they're in the document, so the hook's
 * event would never reach us. This API works whenever we get to the element.
 */
function shadowRootOf(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  if (!(element instanceof HTMLElement)) return null;
  try {
    const firefoxAccess = (element as WithFirefoxShadowAccess).openOrClosedShadowRoot;
    if (firefoxAccess) return firefoxAccess.call(element);
    return chrome.dom.openOrClosedShadowRoot(element);
  } catch {
    return null;
  }
}

function isVideo(target: unknown): target is HTMLVideoElement {
  return target instanceof HTMLVideoElement;
}

/**
 * Finds every video in this frame: through the DOM and shadow roots (layers 1 and 2),
 * from what the page hook announces (4), and from media events (5). Frames (3) each run
 * their own copy. Elements stay in the set until they're out of the document.
 */
export class VideoDiscovery {
  private readonly videos = new Set<HTMLVideoElement>();
  private readonly roots = new Set<Root>();
  private readonly observer: MutationObserver;
  private readonly listeners = new AbortController();
  private fullScanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: () => void) {
    this.observer = new MutationObserver((records) => this.onMutations(records));
  }

  start(): void {
    const { signal } = this.listeners;
    document.addEventListener(ACTIVITY_EVENT, (event) => this.onActivity(event), {
      capture: true,
      signal,
    });
    // Same-document navigation that doesn't go through history, where this is available.
    const navigation = (window as { navigation?: EventTarget }).navigation;
    navigation?.addEventListener("navigatesuccess", () => this.scheduleFullScan(), { signal });
    window.addEventListener("popstate", () => this.scheduleFullScan(), { signal });
    this.fullScan();
  }

  stop(): void {
    this.listeners.abort();
    this.observer.disconnect();
    if (this.fullScanTimer !== null) clearTimeout(this.fullScanTimer);
    this.fullScanTimer = null;
    this.videos.clear();
    this.roots.clear();
  }

  /** The videos still in the document. */
  current(): HTMLVideoElement[] {
    for (const video of this.videos) {
      if (!video.isConnected) this.videos.delete(video);
    }
    return [...this.videos];
  }

  private fullScan(): void {
    const before = this.videos.size;
    this.addRoot(document);
    this.scan(document);
    if (this.videos.size !== before) this.onChange();
  }

  private scheduleFullScan(): void {
    if (this.fullScanTimer !== null) return;
    this.fullScanTimer = setTimeout(() => {
      this.fullScanTimer = null;
      this.fullScan();
    }, FULL_SCAN_DELAY_MS);
  }

  /** Mutations and media events don't cross shadow boundaries, so each root gets its own. */
  private addRoot(root: Root): void {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    this.observer.observe(root, { childList: true, subtree: true });

    const { signal } = this.listeners;
    for (const type of MEDIA_EVENTS) {
      root.addEventListener(type, (event) => this.onMediaEvent(event), { capture: true, signal });
    }
  }

  private scan(root: ParentNode): void {
    if (root instanceof Element) this.visit(root);
    for (const element of root.querySelectorAll("*")) this.visit(element);
  }

  private visit(element: Element): void {
    if (ownElements.has(element)) return;
    if (isVideo(element)) this.videos.add(element);
    const shadow = shadowRootOf(element);
    if (shadow && !this.roots.has(shadow)) {
      this.addRoot(shadow);
      this.scan(shadow);
    }
  }

  private onMutations(records: MutationRecord[]): void {
    const before = this.videos.size;
    let removedSomething = false;
    for (const record of records) {
      if (record.removedNodes.length > 0) removedSomething = true;
      for (const node of record.addedNodes) {
        if (node instanceof Element) this.scan(node);
      }
    }
    if (removedSomething || this.videos.size !== before) this.onChange();
  }

  private onMediaEvent(event: Event): void {
    if (!isVideo(event.target)) return;
    const isNew = !this.videos.has(event.target);
    this.videos.add(event.target);
    // Always worth another look: a video starting to play can change who should win.
    if (isNew || event.type !== "loadedmetadata") this.onChange();
  }

  private onActivity(event: Event): void {
    const [origin] = event.composedPath();
    if (isVideo(origin) && origin.isConnected) {
      this.videos.add(origin);
      this.onChange();
    } else {
      // Navigation, or a video inside a closed root, which shows up here as its host.
      this.scheduleFullScan();
    }
  }
}
