export type Lang = "en" | "pt-BR" | "es";

import { dict as en } from "./en";
import { dict as ptBR } from "./pt-BR";
import { dict as es } from "./es";

const dictionaries: Record<Lang, Record<string, string>> = {
  en,
  "pt-BR": ptBR,
  es,
};

export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "es", label: "Español" },
];

let current: Lang = "en";

export function detectLanguage(): Lang {
  const nav = navigator.language || "en";
  if (/^pt/i.test(nav)) return "pt-BR";
  if (/^es/i.test(nav)) return "es";
  return "en";
}

export function getLanguage(): Lang {
  return current;
}

export function setLanguage(lang: Lang): void {
  current = dictionaries[lang] ? lang : "en";
  document.documentElement.lang = current;
}

type Params = Record<string, string | number>;

export function t(key: string, params?: Params): string {
  let text = dictionaries[current][key] ?? dictionaries.en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
    }
  }
  return text;
}

/** Replace the text of every element carrying data-i18n (and placeholders
 *  via data-i18n-placeholder, titles via data-i18n-title). Called on boot
 *  and on language change. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const input = el as HTMLInputElement;
    input.placeholder = t(el.dataset.i18nPlaceholder!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
}
