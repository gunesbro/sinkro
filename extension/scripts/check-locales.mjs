// Fails when the EN and TR message files drift apart or break store limits.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS = { extName: 75, extDescription: 132 };

const load = async (lang) =>
  JSON.parse(await readFile(join(root, "_locales", lang, "messages.json"), "utf8"));
const placeholders = (entry) =>
  Object.keys(entry.placeholders ?? {})
    .sort()
    .join();

const locales = { en: await load("en"), tr: await load("tr") };
const errors = [];

for (const key of Object.keys(locales.en)) {
  if (!locales.tr[key]) errors.push(`tr is missing "${key}"`);
  else if (placeholders(locales.en[key]) !== placeholders(locales.tr[key]))
    errors.push(`"${key}" has different placeholders in en and tr`);
}
for (const key of Object.keys(locales.tr)) {
  if (!locales.en[key]) errors.push(`en is missing "${key}"`);
}
for (const [lang, messages] of Object.entries(locales)) {
  for (const [key, limit] of Object.entries(LIMITS)) {
    const length = messages[key]?.message.length ?? 0;
    if (length > limit) errors.push(`${lang} "${key}" is ${length} chars, the limit is ${limit}`);
  }
}

// Random names are kept as places in these lists, so every language needs the same number.
const NAME_LISTS = { nameAdjectives: 16, nameAnimals: 16 };
for (const [lang, messages] of Object.entries(locales)) {
  for (const [key, count] of Object.entries(NAME_LISTS)) {
    const words = (messages[key]?.message ?? "").split("|").filter((word) => word.trim() !== "");
    if (words.length !== count)
      errors.push(`${lang} "${key}" has ${words.length} words, needs ${count}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Locales OK: ${Object.keys(locales.en).length} messages in en and tr.`);
