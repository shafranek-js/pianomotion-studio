import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadStudioSong } from "./studio-helpers";

async function openLibrary(page: Page) {
  const trigger = page.getByTestId("studio-tool-rail").getByRole("button", { name: "Browse built-in melodies", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list").getByRole("listitem").first()).toBeVisible();
  return dialog;
}

async function readRows(dialog: Locator) {
  const rows = dialog.getByRole("list").getByRole("listitem");
  const result: Array<{ title: string; score: number }> = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const label = await row.getByRole("button", { name: /^Open / }).getAttribute("aria-label");
    const score = (await row.innerText()).match(/Difficulty\s+(\d+(?:\.\d+)?)\/10/);
    result.push({ title: label?.replace(/^Open /, "") ?? "", score: Number(score?.[1]) });
  }
  return result;
}

async function expectBeginnerPreferences(dialog: Locator) {
  await expect(dialog.getByRole("tab", { name: /^Beginner/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("combobox", { name: "Sort melodies" })).toHaveValue("difficulty-desc");
  await expect(dialog.getByRole("searchbox", { name: "Search melodies" })).toHaveValue("Au Clair");
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Open Au Clair de la Lune", exact: true })).toBeVisible();
}

test("built-in melody preferences survive reopening, reload, and the welcome-to-player transition", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });

  let dialog = await openLibrary(page);
  const search = dialog.getByRole("searchbox", { name: "Search melodies" });
  const sort = dialog.getByRole("combobox", { name: "Sort melodies" });
  await expect(search).toHaveValue("");
  await expect(sort).toHaveValue("title");
  await expect(dialog.getByRole("tab", { name: /^All tags/ })).toHaveAttribute("aria-selected", "true");

  await dialog.getByRole("tab", { name: /^Beginner/ }).click();
  await sort.selectOption("difficulty-desc");
  await search.fill("A");
  const broadBeginnerRows = await readRows(dialog);
  expect(broadBeginnerRows.length).toBeGreaterThan(1);
  expect(broadBeginnerRows.every((row) => Number.isFinite(row.score))).toBe(true);
  expect(broadBeginnerRows.map((row) => row.score)).toEqual(
    [...broadBeginnerRows.map((row) => row.score)].sort((left, right) => right - left),
  );
  expect(broadBeginnerRows.map((row) => row.title)).toContain("Au Clair de la Lune");

  await search.fill("Au Clair");
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  dialog = await openLibrary(page);
  await expectBeginnerPreferences(dialog);

  await page.reload();
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  dialog = await openLibrary(page);
  await expectBeginnerPreferences(dialog);
  const screenshot = testInfo.outputPath("library-preferences-restored.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("library-preferences-restored", { path: screenshot, contentType: "image/png" });

  // Import a tiny real MIDI through the normal path to exercise the same
  // preferences after the app moves from its welcome state into the player.
  await loadStudioSong(page, { output: "synth", dimension: "2d" });
  dialog = await openLibrary(page);
  await expectBeginnerPreferences(dialog);

  await dialog.getByRole("tab", { name: /^All tags/ }).click();
  await dialog.getByRole("combobox", { name: "Sort melodies" }).selectOption("title");
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("");
  await page.keyboard.press("Escape");
  await page.reload();
  dialog = await openLibrary(page);
  await expect(dialog.getByRole("tab", { name: /^All tags/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("combobox", { name: "Sort melodies" })).toHaveValue("title");
  await expect(dialog.getByRole("searchbox", { name: "Search melodies" })).toHaveValue("");
});

test("favourites filtering persists without changing the saved melody stars", async ({ page }) => {
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  let dialog = await openLibrary(page);
  const search = dialog.getByRole("searchbox", { name: "Search melodies" });
  const sort = dialog.getByRole("combobox", { name: "Sort melodies" });

  await search.fill("Au Clair");
  const auClairRow = dialog.getByRole("list").getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Open Au Clair de la Lune", exact: true }),
  });
  await auClairRow.getByRole("button", { name: "Add to favorites: Au Clair de la Lune", exact: true }).click();
  await expect(auClairRow.getByRole("button", { name: "Remove from favorites: Au Clair de la Lune", exact: true })).toHaveAttribute("aria-pressed", "true");

  await search.fill("A Tisket");
  const tisketRow = dialog.getByRole("list").getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Open A Tisket, A Tasket", exact: true }),
  });
  await tisketRow.getByRole("button", { name: "Add to favorites: A Tisket, A Tasket", exact: true }).click();
  await expect(tisketRow.getByRole("button", { name: "Remove from favorites: A Tisket, A Tasket", exact: true })).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("tab", { name: /^Favorites/ }).click();
  await sort.selectOption("difficulty-asc");
  await search.fill("A");
  const favourites = await readRows(dialog);
  expect(favourites).toEqual([
    { title: "A Tisket, A Tasket", score: 1.6 },
    { title: "Au Clair de la Lune", score: 2.2 },
  ]);

  await page.reload();
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  dialog = await openLibrary(page);
  await expect(dialog.getByRole("tab", { name: /^Favorites/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("combobox", { name: "Sort melodies" })).toHaveValue("difficulty-asc");
  await expect(dialog.getByRole("searchbox", { name: "Search melodies" })).toHaveValue("A");
  expect(await readRows(dialog)).toEqual(favourites);

  const restoredAuClairRow = dialog.getByRole("list").getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Open Au Clair de la Lune", exact: true }),
  });
  const restoredTisketRow = dialog.getByRole("list").getByRole("listitem").filter({
    has: page.getByRole("button", { name: "Open A Tisket, A Tasket", exact: true }),
  });
  await expect(restoredAuClairRow.getByRole("button", { name: "Remove from favorites: Au Clair de la Lune", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(restoredTisketRow.getByRole("button", { name: "Remove from favorites: A Tisket, A Tasket", exact: true })).toHaveAttribute("aria-pressed", "true");
});
