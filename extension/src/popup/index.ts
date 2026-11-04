import { getLanguage, loadMessages, setLanguage, translate, type Language } from "../i18n";

async function render(language: Language): Promise<void> {
  const messages = await loadMessages(language);
  document.documentElement.lang = language;

  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = translate(messages, element.dataset.i18n ?? "");
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", translate(messages, element.dataset.i18nAriaLabel ?? ""));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === language));
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
  button.addEventListener("click", async () => {
    const language = button.dataset.lang as Language;
    await setLanguage(language);
    await render(language);
  });
}

void getLanguage().then(render);
