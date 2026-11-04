// Runs in the page's own world, ahead of its scripts, because the content script can't
// see what page code calls. It only announces that something happened: nothing flows
// back into the page, and a page faking the event can do no more than cause a rescan.
import { ACTIVITY_EVENT } from "../content/detection/activity";

function announce(target: EventTarget): void {
  target.dispatchEvent(new CustomEvent(ACTIVITY_EVENT, { bubbles: true, composed: true }));
}

/** Pages must never break because of us, so anything going wrong here stays quiet. */
function announceSafely(target: EventTarget): void {
  try {
    announce(target);
  } catch {
    // Nothing useful to do.
  }
}

const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
  announceSafely(this);
  return nativePlay.call(this);
};

const srcProperty = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
if (srcProperty?.set && srcProperty.get) {
  const { get, set } = srcProperty;
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    ...srcProperty,
    get,
    set(this: HTMLMediaElement, value: string) {
      set.call(this, value);
      announceSafely(this);
    },
  });
}

for (const method of ["pushState", "replaceState"] as const) {
  const native = History.prototype[method];
  History.prototype[method] = function (
    this: History,
    ...args: Parameters<History["pushState"]>
  ): void {
    native.apply(this, args);
    announceSafely(document);
  };
}
