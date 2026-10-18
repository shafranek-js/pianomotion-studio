import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ProjectPackageSchema } from "@handthesia/contracts";
import { exportStudioPackage, loadStudioSong, saveStudioProject, studioMidiPath } from "./studio-helpers";

type MenuDefinition = {
  label: "File" | "Export";
  items: Array<{ name: string; enabled: boolean }>;
};

const fileMenu: MenuDefinition = {
  label: "File",
  items: [
    { name: "Open MIDI...", enabled: true },
    { name: "Built-in melodies…", enabled: true },
    { name: "Open project package…", enabled: true },
    { name: "Open saved project…", enabled: true },
    { name: "Save project", enabled: false },
  ],
};

const projectFileMenu: MenuDefinition = {
  ...fileMenu,
  items: fileMenu.items.map((item) => ({ ...item, enabled: true })),
};

const exportMenu: MenuDefinition = {
  label: "Export",
  items: [
    { name: "Fingered MIDI (.mid)", enabled: false },
    { name: "Project package (.json)", enabled: false },
    { name: "Performance video (.mp4 / .webm)", enabled: false },
  ],
};

const projectExportMenu: MenuDefinition = {
  ...exportMenu,
  items: exportMenu.items.map((item) => ({ ...item, enabled: true })),
};

async function readHeaderScroll(page: Page) {
  return page.getByTestId("studio-header").evaluate((header) => ({
    left: header.scrollLeft,
    top: header.scrollTop,
    maxLeft: Math.max(0, header.scrollWidth - header.clientWidth),
  }));
}

/**
 * Check actual screen geometry and hit-testing. Playwright visibility alone
 * still reports items hidden behind an overflow-clipped header as visible.
 */
async function inspectMenu(
  page: Page,
  definition: MenuDefinition,
  capture?: { testInfo: TestInfo; name: string },
) {
  const trigger = page.getByTestId("studio-header").getByRole("button", { name: definition.label, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const scrollBeforeOpen = await readHeaderScroll(page);
  await trigger.click();

  const menu = page.getByRole("menu", { name: definition.label, exact: true });
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveCount(definition.items.length);

  for (const item of definition.items) {
    const locator = menu.getByRole("menuitem", { name: item.name, exact: true });
    await expect(locator).toBeVisible();
    if (item.enabled) await expect(locator).toBeEnabled();
    else await expect(locator).toBeDisabled();
  }

  if (capture) {
    const screenshot = await page.screenshot({ path: capture.testInfo.outputPath(capture.name) });
    await capture.testInfo.attach(capture.name, { body: screenshot, contentType: "image/png" });
  }

  const popupMetrics = await menu.evaluate((popup) => {
    const rect = popup.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      scrollHeight: popup.scrollHeight,
      clientHeight: popup.clientHeight,
      items: Array.from(popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((item) => {
        const itemRect = item.getBoundingClientRect();
        const x = itemRect.left + itemRect.width / 2;
        const y = itemRect.top + itemRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          name: item.innerText.trim(),
          x: itemRect.x,
          y: itemRect.y,
          right: itemRect.right,
          bottom: itemRect.bottom,
          width: itemRect.width,
          height: itemRect.height,
          centerInViewport: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
          centerHitsItem: Boolean(hit && (hit === item || item.contains(hit))),
          visible: getComputedStyle(item).visibility !== "hidden" && getComputedStyle(item).display !== "none",
        };
      }),
    };
  });
  const anchorMetrics = await trigger.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      centerInViewport: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
      centerHitsTrigger: Boolean(hit && (hit === element || element.contains(hit))),
    };
  });
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const scrollAfterOpen = await readHeaderScroll(page);

  expect(anchorMetrics.centerInViewport, `${definition.label} trigger center must stay on screen`).toBe(true);
  expect(anchorMetrics.centerHitsTrigger, `${definition.label} trigger must remain the painted hit target`).toBe(true);
  expect(scrollAfterOpen.top, `${definition.label} opening must not vertically scroll the header`).toBe(0);
  expect(scrollAfterOpen.left, `${definition.label} focus must preserve the scrolled header anchor`).toBe(scrollBeforeOpen.left);

  expect(popupMetrics.width, `${definition.label} popup must have a painted width`).toBeGreaterThan(0);
  expect(popupMetrics.height, `${definition.label} popup must have a painted height`).toBeGreaterThan(0);
  expect(popupMetrics.x, `${definition.label} popup must stay inside the left viewport edge`).toBeGreaterThanOrEqual(0);
  expect(popupMetrics.right, `${definition.label} popup must stay inside the right viewport edge`).toBeLessThanOrEqual(viewport.width);
  expect(popupMetrics.y, `${definition.label} popup must stay inside the top viewport edge`).toBeGreaterThanOrEqual(0);
  expect(popupMetrics.bottom, `${definition.label} popup must stay inside the bottom viewport edge`).toBeLessThanOrEqual(viewport.height);
  expect(popupMetrics.y, `${definition.label} popup must open from its header anchor`).toBeGreaterThanOrEqual(anchorMetrics.bottom);
  expect(popupMetrics.y - anchorMetrics.bottom, `${definition.label} popup gap must remain attached to its anchor`).toBeLessThanOrEqual(16);
  expect(popupMetrics.items.map((item) => item.name)).toEqual(definition.items.map((item) => item.name));

  if (popupMetrics.scrollHeight <= popupMetrics.clientHeight + 1) {
    for (const item of popupMetrics.items) {
      expect(item.visible, `${definition.label} item ${item.name} must be painted`).toBe(true);
      expect(item.x, `${definition.label} item ${item.name} left edge`).toBeGreaterThanOrEqual(0);
      expect(item.y, `${definition.label} item ${item.name} top edge`).toBeGreaterThanOrEqual(0);
      expect(item.right, `${definition.label} item ${item.name} right edge`).toBeLessThanOrEqual(viewport.width);
      expect(item.bottom, `${definition.label} item ${item.name} bottom edge`).toBeLessThanOrEqual(viewport.height);
      expect(item.centerInViewport, `${definition.label} item ${item.name} center must be on screen`).toBe(true);
      expect(item.centerHitsItem, `${definition.label} item ${item.name} center must hit the actual item`).toBe(true);
    }
  } else {
    // A very short viewport may need an internally scrollable menu. Scroll each
    // real item into view and hit-test it, including disabled items.
    for (const item of definition.items) {
      const locator = menu.getByRole("menuitem", { name: item.name, exact: true });
      await locator.scrollIntoViewIfNeeded();
      const hitMetrics = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          centerInViewport: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
          centerHitsItem: Boolean(hit && (hit === element || element.contains(hit))),
        };
      });
      expect(hitMetrics.x, `${definition.label} scrolled item ${item.name} left edge`).toBeGreaterThanOrEqual(0);
      expect(hitMetrics.y, `${definition.label} scrolled item ${item.name} top edge`).toBeGreaterThanOrEqual(0);
      expect(hitMetrics.right, `${definition.label} scrolled item ${item.name} right edge`).toBeLessThanOrEqual(viewport.width);
      expect(hitMetrics.bottom, `${definition.label} scrolled item ${item.name} bottom edge`).toBeLessThanOrEqual(viewport.height);
      expect(hitMetrics.centerInViewport, `${definition.label} scrolled item ${item.name} center must be on screen`).toBe(true);
      expect(hitMetrics.centerHitsItem, `${definition.label} scrolled item ${item.name} center must hit the actual item`).toBe(true);
    }
  }

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
}

async function readSavedProject(page: Page, projectId: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction("projects", "readonly").objectStore("projects").get(id);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, projectId);
}

test("empty File and Export menus stay fully painted and keep keyboard and outside-click focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?empty=true");
  await expect(page).toHaveTitle("PianoMotion Studio");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");

  await inspectMenu(page, fileMenu, { testInfo, name: "empty-desktop-file.png" });
  await inspectMenu(page, exportMenu, { testInfo, name: "empty-desktop-export.png" });

  const fileTrigger = page.getByTestId("studio-header").getByRole("button", { name: "File", exact: true });
  await fileTrigger.click();
  const filePopover = page.getByRole("menu", { name: "File", exact: true });
  await expect(filePopover.getByRole("menuitem", { name: "Open MIDI...", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(filePopover.getByRole("menuitem", { name: "Open saved project…", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(filePopover.getByRole("menuitem", { name: "Open MIDI...", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(filePopover.getByRole("menuitem", { name: "Built-in melodies…", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(filePopover).toHaveCount(0);
  await expect(fileTrigger).toBeFocused();

  // Switching directly to another header menu is an outside click for the
  // first popup and must open the new menu without leaving either stale.
  const exportTrigger = page.getByTestId("studio-header").getByRole("button", { name: "Export", exact: true });
  await fileTrigger.click();
  await expect(page.getByRole("menu", { name: "File", exact: true })).toBeVisible();
  await exportTrigger.click();
  await expect(page.getByRole("menu", { name: "File", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Export", exact: true })).toBeVisible();
  await expect(exportTrigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(exportTrigger).toBeFocused();

  await fileTrigger.click();
  const performanceView = page.getByTestId("studio-header").getByRole("button", { name: "Performance", exact: true });
  await performanceView.click();
  await expect(page.getByRole("menu", { name: "File", exact: true })).toHaveCount(0);
  await expect(fileTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(performanceView).toBeFocused();
});

test("project menus remain reachable at desktop and mobile sizes and perform real save and JSON export", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const loaded = await loadStudioSong(page, { output: "synth", dimension: "2d" });

  await inspectMenu(page, projectFileMenu, { testInfo, name: "project-desktop-file.png" });
  await inspectMenu(page, projectExportMenu, { testInfo, name: "project-desktop-export.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(390);
  await inspectMenu(page, projectFileMenu, { testInfo, name: "project-mobile-file.png" });
  await inspectMenu(page, projectExportMenu, { testInfo, name: "project-mobile-export.png" });

  // At phone width and short height the whole menu must remain usable through
  // its own scroll container, with every item still receiving pointer input.
  await page.setViewportSize({ width: 390, height: 260 });
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(260);
  await inspectMenu(page, projectFileMenu);

  // Exercise the real persistent save action and verify its IndexedDB record.
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveStudioProject(page);
  expect(await readSavedProject(page, loaded.result.projectId)).not.toBeNull();

  // Export from the visible menu through the real app callback and validate
  // both the package contract and the original MIDI bytes in its payload.
  const packagePath = await exportStudioPackage(page);
  const pkg = ProjectPackageSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
  expect(pkg.packageVersion).toBe(2);
  expect(pkg.document.projectId).toBe(loaded.result.projectId);
  const source = pkg.resources.find((resource) => resource.resourceId === pkg.document.sourceMidiResourceId);
  expect(source).toBeDefined();
  expect(Buffer.from(pkg.resourcePayloads![source!.path]!, "base64")).toEqual(await readFile(studioMidiPath));
});
