import { afterEach, describe, expect, it } from "vitest";
import {
  applyThemePreference,
  nextThemePreference,
  readThemePreference,
  THEME_LABELS,
} from "./theme";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme preference", () => {
  it("defaults to following the system", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("pins the palette with data-theme and remembers the choice", () => {
    applyThemePreference("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("clears the override so the OS decides again", () => {
    applyThemePreference("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyThemePreference("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(readThemePreference()).toBe("system");
  });

  it("cycles system → light → dark → system with a label for each", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
    expect(THEME_LABELS.system).toBe("跟随系统");
    expect(THEME_LABELS.light).toBe("浅色");
    expect(THEME_LABELS.dark).toBe("深色");
  });
});
