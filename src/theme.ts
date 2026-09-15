export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "markread.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") return media.matches ? "dark" : "light";
  return preference;
}

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  applyTheme();
}

export function applyTheme(): void {
  const resolved = resolve(getThemePreference());
  document.documentElement.dataset.theme = resolved;
}

/** Re-resolve when the OS switches between light and dark while on "system". */
export function initTheme(): void {
  applyTheme();
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme();
  });
}
