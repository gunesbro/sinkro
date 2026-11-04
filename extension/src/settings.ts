const SERVER_URL_KEY = "serverUrl";

/** Replaced with the hosted server's address once it's deployed. */
export const DEFAULT_SERVER_URL = "http://localhost:8787";

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

export async function getServerUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(SERVER_URL_KEY);
  const saved = stored[SERVER_URL_KEY];
  return (typeof saved === "string" && normalizeServerUrl(saved)) || DEFAULT_SERVER_URL;
}

/** Returns false if the URL was rejected. */
export async function setServerUrl(input: string): Promise<boolean> {
  const serverUrl = normalizeServerUrl(input);
  if (!serverUrl) return false;
  await chrome.storage.local.set({ [SERVER_URL_KEY]: serverUrl });
  return true;
}
