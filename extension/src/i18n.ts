// chrome.i18n always follows the browser language, so it can't honour the EN/TR
// switch. Messages are read from the same _locales files and formatted here.

export const LANGUAGES = ["en", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

type Message = {
  message: string;
  placeholders?: Record<string, { content: string }>;
};
export type Messages = Record<string, Message>;

const STORAGE_KEY = "language";

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

export async function getLanguage(): Promise<Language> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY];
  if (isLanguage(saved)) return saved;

  const browserLanguage = chrome.i18n.getUILanguage().split("-")[0];
  return isLanguage(browserLanguage) ? browserLanguage : "en";
}

export async function setLanguage(language: Language): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: language });
}

export async function loadMessages(language: Language): Promise<Messages> {
  const url = chrome.runtime.getURL(`_locales/${language}/messages.json`);
  const response = await fetch(url);
  return (await response.json()) as Messages;
}

/** Same placeholder rules as chrome.i18n.getMessage: $NAME$ maps to $1, $2, ... */
export function translate(messages: Messages, key: string, substitutions: string[] = []): string {
  const entry = messages[key];
  if (!entry) return key;
  return entry.message.replace(/\$([a-z0-9_@]+)\$/gi, (_, name: string) => {
    const content = entry.placeholders?.[name.toLowerCase()]?.content ?? "";
    return content.replace(
      /\$([1-9])/g,
      (_, index: string) => substitutions[Number(index) - 1] ?? "",
    );
  });
}
