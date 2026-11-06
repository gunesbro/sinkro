// What every scenario shares: where things are, which browser, and a local server to talk to.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function shotDir() {
  const chosen = process.env.SINKRO_SHOTS;
  if (!chosen) return mkdtempSync(join(tmpdir(), "sinkro-shots-"));
  mkdirSync(chosen, { recursive: true });
  return resolve(chosen);
}

export const config = {
  /** The built extension, `npm run build` first. */
  extPath: resolve(process.env.SINKRO_EXTENSION ?? join(root, "extension/dist/chrome")),
  serverDir: join(root, "server"),
  siteDir: join(root, "site"),
  /** Screenshots, kept for a look when something fails. */
  shotDir: shotDir(),
  /** Playwright's own Chromium by default; `msedge` or `chrome` uses an installed browser. */
  channel: process.env.SINKRO_BROWSER ?? "chromium",
  /** How long the sync scenario lets three people play together. */
  soakSeconds: process.env.SINKRO_SOAK ?? "30",
};

/**
 * Opens one of the extension's pages. Right after the extension reloads, the browser refuses
 * its pages for a moment, longer in some browsers than others.
 */
export async function openExtensionPage(page, url, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await page.goto(url);
    } catch (error) {
      if (Date.now() > end || !String(error).includes("ERR_BLOCKED_BY_CLIENT")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * As anyone loading Sinkro unpacked has it. Without it, newer Chromium turns an unpacked
 * extension off when it reloads.
 */
export async function enableDeveloperMode(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve),
      ),
  );
  await page.close();
}

const servers = new Set();
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");

/** A local copy of the server, as `wrangler dev` runs it, with nothing sent to Cloudflare. */
export function startServer(port) {
  const child = spawn(process.execPath, [wrangler, "dev", "--port", String(port)], {
    cwd: config.serverDir,
    stdio: "ignore",
    // Its own process group, so stopping it also stops the runtime it starts.
    detached: process.platform !== "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  servers.add(child);
  return child;
}

/** Stops every server this scenario started, with everything they started. */
export function stopServers() {
  let stopped = 0;
  for (const child of servers) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
      stopped += 1;
    } catch {
      // Already gone.
    }
  }
  servers.clear();
  // Gives the port back before anyone starts the next one on it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  return `stopped ${stopped}`;
}
