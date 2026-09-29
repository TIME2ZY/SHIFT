/**
 * App-level colour scheme preference.
 *
 * The palette is two explicit token sets in `styles/tokens.css`, selected by
 * `data-theme` on the document element (or by the OS media query when the
 * preference is "system"). "system" removes the attribute entirely so the
 * media query decides.
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "shift.theme";

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Preference is a convenience; a full store must not block the render.
  }
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export function nextThemePreference(current: ThemePreference): ThemePreference {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}
