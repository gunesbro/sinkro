// Builds one unpacked extension per browser into dist/<target>.
// Edge loads the Chrome build. The only difference between targets is the manifest.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const baseManifest = JSON.parse(await readFile(join(root, "manifest.base.json"), "utf8"));

const targetManifest = {
  chrome: {
    background: { service_worker: "background.js" },
  },
  firefox: {
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: "sinkro@sinkro.pages.dev",
        strict_min_version: "142.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  },
};

for (const [target, overrides] of Object.entries(targetManifest)) {
  const outdir = join(root, "dist", target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: {
      background: join(root, "src/background/index.ts"),
      content: join(root, "src/content/index.ts"),
      "page-hook": join(root, "src/page/hook.ts"),
      popup: join(root, "src/popup/index.ts"),
    },
    outdir,
    bundle: true,
    format: "iife",
    target: "es2022",
    logLevel: "warning",
  });

  await cp(join(root, "_locales"), join(outdir, "_locales"), { recursive: true });
  await cp(join(root, "src/popup/popup.html"), join(outdir, "popup.html"));
  await cp(join(root, "src/popup/popup.css"), join(outdir, "popup.css"));
  await writeFile(
    join(outdir, "manifest.json"),
    JSON.stringify({ ...baseManifest, version, ...overrides }, null, 2) + "\n",
  );
}
