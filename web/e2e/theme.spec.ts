import { expect, test } from "@playwright/test";

test("saved theme controls the native color scheme when the OS disagrees", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => window.localStorage.setItem("shift.theme", "light"));
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme)).toBe(
    "light"
  );

  await page.getByRole("button", { name: /外观：浅色/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme)).toBe(
    "dark"
  );
});
