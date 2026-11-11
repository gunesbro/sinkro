// Prints "yes" if addons.mozilla.org already has this version of Sinkro, listed or not, and "no"
// otherwise. AMO takes each version number once, so the release skips signing one it has, such
// as a version uploaded by hand. Needs AMO_JWT_ISSUER and AMO_JWT_SECRET.
// node extension/scripts/amo-has-version.mjs <version>
import { createHmac, randomUUID } from "node:crypto";

const ADDON_ID = "sinkro@sinkro.pages.dev";
const [version] = process.argv.slice(2);
const { AMO_JWT_ISSUER: issuer, AMO_JWT_SECRET: secret } = process.env;
if (!version || !issuer || !secret) {
  console.error("Usage: AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node amo-has-version.mjs <version>");
  process.exit(2);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
/** The short-lived token AMO's API takes, signed with the key's secret. */
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

let next = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/?filter=all_with_unlisted&page_size=50`;
while (next) {
  const response = await fetch(next, { headers: { Authorization: `JWT ${token()}` } });
  // No add-on yet means no version either.
  if (response.status === 404) break;
  if (!response.ok) {
    console.error(`AMO answered ${response.status}`);
    process.exit(1);
  }
  const page = await response.json();
  if (page.results.some((entry) => entry.version === version)) {
    console.log("yes");
    process.exit(0);
  }
  next = page.next;
}
console.log("no");
