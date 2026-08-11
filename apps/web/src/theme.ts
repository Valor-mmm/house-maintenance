/**
 * Manual light/dark override on top of the OS-preference default (see
 * src/index.css). "system" means no override — the `prefers-color-scheme`
 * media query alone decides. Key must match the inline script in
 * index.html exactly, since that script applies the saved choice before
 * the bundle loads and can't import this module.
 */
export const THEME_STORAGE_KEY = "house-maintenance:theme";
export type ThemeChoice = "system" | "light" | "dark";

export function getStoredTheme(): ThemeChoice {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
    document.documentElement.dataset.theme = choice;
  }
}

export function nextTheme(current: ThemeChoice): ThemeChoice {
  const order: ThemeChoice[] = ["system", "light", "dark"];
  return order[(order.indexOf(current) + 1) % order.length];
}
