const SERVER_URL_KEY = "serverUrl";

export const DEFAULT_SERVER_URL = "https://sinkro.sinkro.workers.dev";

/** Returns the URL without a trailing slash, or null if it can't be a Sinkro server. */
export function normalizeServerUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function roomSocketUrl(serverUrl: string, code: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/rooms/${encodeURIComponent(code)}/ws`;
}

/** The server the viewer chose for themselves, or null for Sinkro's own. */
export async function getCustomServerUrl(): Promise<string | null> {
  const stored = await chrome.storage.local.get(SERVER_URL_KEY);
  const saved = stored[SERVER_URL_KEY];
  const serverUrl = typeof saved === "string" ? normalizeServerUrl(saved) : null;
  return serverUrl && serverUrl !== DEFAULT_SERVER_URL ? serverUrl : null;
}

export async function getServerUrl(): Promise<string> {
  return (await getCustomServerUrl()) ?? DEFAULT_SERVER_URL;
}

/**
 * An empty field, or Sinkro's own address, goes back to Sinkro's server. Returns false if the
 * address was rejected.
 */
export async function setServerUrl(input: string): Promise<boolean> {
  if (input.trim() === "") {
    await chrome.storage.local.remove(SERVER_URL_KEY);
    return true;
  }
  const serverUrl = normalizeServerUrl(input);
  if (!serverUrl) return false;
  if (serverUrl === DEFAULT_SERVER_URL) await chrome.storage.local.remove(SERVER_URL_KEY);
  else await chrome.storage.local.set({ [SERVER_URL_KEY]: serverUrl });
  return true;
}
