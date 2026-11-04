// Remembers the viewer's pick per site, on this device only. It never reaches the server.
const MAX_DEPTH = 6;
const MAX_CLASSES = 2;

const keyFor = (hostname: string) => `picked:${hostname}`;

/** Class names like these are generated at build time and change between visits. */
function isStableName(name: string): boolean {
  return /^[a-zA-Z][\w-]*$/.test(name) && !/\d{3,}/.test(name);
}

/** A selector that should find the same video again on a later visit. */
export function selectorFor(video: Element): string {
  const parts: string[] = [];
  let element: Element | null = video;
  for (let depth = 0; element && depth < MAX_DEPTH; depth += 1) {
    if (element.id && isStableName(element.id)) {
      parts.unshift(`#${CSS.escape(element.id)}`);
      break;
    }
    const classes = [...element.classList]
      .filter(isStableName)
      .slice(0, MAX_CLASSES)
      .map((name) => `.${CSS.escape(name)}`)
      .join("");
    parts.unshift(`${element.localName}${classes}`);
    element = element.parentElement;
  }
  return parts.join(" > ");
}

export async function loadRemembered(hostname: string): Promise<string | null> {
  const key = keyFor(hostname);
  const stored = await chrome.storage.local.get(key);
  const selector = stored[key];
  return typeof selector === "string" ? selector : null;
}

export async function saveRemembered(hostname: string, selector: string): Promise<void> {
  await chrome.storage.local.set({ [keyFor(hostname)]: selector });
}

export async function forgetRemembered(hostname: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(hostname));
}
