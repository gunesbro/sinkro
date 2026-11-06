// Runs the browser scenarios one after another: `node tests/e2e/run.mjs [name...] [--repeat N]`.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const all = readdirSync(here)
  .filter((file) => file.endsWith(".e2e.mjs"))
  .map((file) => file.replace(".e2e.mjs", ""));

const args = process.argv.slice(2);
const repeatAt = args.indexOf("--repeat");
const repeat = repeatAt >= 0 ? Number(args.splice(repeatAt, 2)[1]) : 1;
const chosen = args.length > 0 ? args : all;
const unknown = chosen.filter((name) => !all.includes(name));
if (unknown.length > 0) {
  console.error(`No such scenario: ${unknown.join(", ")}. There are: ${all.join(", ")}`);
  process.exit(2);
}

/** Each in its own process, as one that hangs or crashes mustn't take the others with it. */
function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${name}.e2e.mjs`)], { stdio: "inherit" });
    // Longer than the longest scenario, so only a hang reaches it.
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const failed = [];
for (let round = 1; round <= repeat; round += 1) {
  for (const name of chosen) {
    console.log(`\n=== ${name}${repeat > 1 ? ` (${round}/${repeat})` : ""}`);
    if (!(await run(name))) failed.push(repeat > 1 ? `${name} (${round})` : name);
  }
}
console.log(failed.length > 0 ? `\nFailed: ${failed.join(", ")}` : "\nEvery scenario passed.");
process.exit(failed.length > 0 ? 1 : 0);
