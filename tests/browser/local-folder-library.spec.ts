import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  configureStudioTestOutput,
  expectStudioCanvas,
  settledStudio,
  studioCanvas,
} from "./studio-helpers";

const LOCAL_LIBRARY_KEY = "melodies.local_folder_library.v1";

function encodeMidiDelta(value: number): number[] {
  const bytes = [value & 0x7f];
  let remaining = value >>> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return bytes;
}

function makeMidi(noteCount: number, noteDurationTicks = 96): Uint8Array {
  const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]; // 120 BPM
  for (let index = 0; index < noteCount; index += 1) {
    const pitch = 60 + (index % 24);
    track.push(0x00, 0x90, pitch, 0x64, ...encodeMidiDelta(noteDurationTicks), 0x80, pitch, 0x00);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x60, 0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ]);
}

const SMALL_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Local XML Study</work-title></work>
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

async function installBrowserInstrumentation(page: Page, opfsDirectoryName: string | null = null): Promise<void> {
  await page.addInitScript((directoryName) => {
    const testWindow = window as Window & {
      __localLibraryAudioContexts?: AudioContext[];
    };
    testWindow.__localLibraryAudioContexts = [];

    // The fallback test disables this picker. The OPFS case returns a real
    // browser directory handle; native picker UI and permission prompts remain
    // manual evidence.
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: directoryName
        ? async () => {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle(directoryName);
          }
        : undefined,
    });

    const NativeAudioContext = window.AudioContext;
    if (NativeAudioContext) {
      const trackedAudioContext = new Proxy(NativeAudioContext, {
        construct(target, args) {
          const context = Reflect.construct(target, args) as AudioContext;
          testWindow.__localLibraryAudioContexts?.push(context);
          return context;
        },
      });
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        writable: true,
        value: trackedAudioContext,
      });
    }
  }, opfsDirectoryName);
}

async function openLibrary(page: Page) {
  await page
    .getByTestId("studio-tool-rail")
    .getByRole("button", { name: "Browse melody library", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Melody library", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function getMelodyRows(dialog: Locator): Locator {
  return dialog.getByRole("list", { name: "Built-in Melodies", exact: true }).getByRole("listitem");
}

async function readLocalLibrarySnapshot(page: Page): Promise<{
  revision: number;
  sources: Array<{ id: string; name: string; lastScanErrorCount: number }>;
  entries: Array<{
    id: string;
    relativePath: string;
    title: string;
    sourceFormat: string;
    firstLevelFolder: string | null;
    noteCount: number;
    durationSeconds: number;
    difficultyScore: number;
    difficultyTier: string;
    previewNotes?: Array<{ noteId: string; pitch: number; velocity: number; startSeconds: number; endSeconds: number }>;
  }>;
} | null> {
  return page.evaluate(async (storageKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("settings", "readonly").objectStore("settings").get(storageKey);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, LOCAL_LIBRARY_KEY);
}

async function readPersistedDirectoryHandles(page: Page): Promise<Array<{
  kind: string | undefined;
  name: string;
  directoryHandleName?: string;
  children: Array<{ kind: string; name: string }>;
}>> {
  return page.evaluate(async (storageKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const snapshot = await new Promise<{
        sources: Array<{
          kind?: string;
          name: string;
          directoryHandle?: FileSystemDirectoryHandle;
        }>;
      } | null>((resolve, reject) => {
        const request = db.transaction("settings", "readonly").objectStore("settings").get(storageKey);
        request.onsuccess = () => resolve((request.result?.value ?? null) as {
          sources: Array<{
            kind?: string;
            name: string;
            directoryHandle?: FileSystemDirectoryHandle;
          }>;
        } | null);
        request.onerror = () => reject(request.error);
      });
      if (!snapshot) return [];
      const summaries: Array<{
        kind: string | undefined;
        name: string;
        directoryHandleName?: string;
        children: Array<{ kind: string; name: string }>;
      }> = [];
      for (const source of snapshot.sources) {
        const children: Array<{ kind: string; name: string }> = [];
        if (source.directoryHandle) {
          for await (const child of source.directoryHandle.values()) {
            children.push({ kind: child.kind, name: child.name });
          }
        }
        summaries.push({
          kind: source.kind,
          name: source.name,
          ...(source.directoryHandle ? { directoryHandleName: source.directoryHandle.name } : {}),
          children,
        });
      }
      return summaries;
    } finally {
      db.close();
    }
  }, LOCAL_LIBRARY_KEY);
}

async function getProjectId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__playerSnapshot?.result.projectId);
}

async function getSeekValue(page: Page): Promise<number> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Seek position"]');
    return input ? Number(input.value) : Number.NaN;
  });
}

test("fallback local library scans, cancels and rescans atomically, previews independently, persists, and commits recents only after open", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await installBrowserInstrumentation(page);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pianomotion-local-library-"));
  const melodyFolder = join(temporaryRoot, "local-score-library");
  const activeMidiPath = join(temporaryRoot, "long-project.mid");
  const midiPath = join(melodyFolder, "Nested", "Local MIDI Study.mid");
  const brokenMidiPath = join(melodyFolder, "Nested", "Broken.mid");
  const musicXmlPath = join(melodyFolder, "MusicXML", "Local XML Study.musicxml");

  try {
    await mkdir(join(melodyFolder, "Nested"), { recursive: true });
    await mkdir(join(melodyFolder, "MusicXML"), { recursive: true });
    await writeFile(activeMidiPath, makeMidi(120));
    await writeFile(midiPath, makeMidi(1, 1536));
    await writeFile(brokenMidiPath, Buffer.from("not a MIDI file", "utf8"));
    await writeFile(musicXmlPath, SMALL_MUSICXML, "utf8");

    const libraryWorkerUrls: string[] = [];
    page.on("worker", (worker) => {
      if (worker.url().includes("libraryAnalysisWorker")) libraryWorkerUrls.push(worker.url());
    });

    await page.goto("/?empty=true");
    await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });
    await configureStudioTestOutput(page);
    await page.locator("#midi-file").setInputFiles(activeMidiPath);
    await expectStudioCanvas(page, 120_000);
    const initialProject = await settledStudio(page, 0);
    expect(initialProject.result.document!.notes).toHaveLength(120);
    await page.getByRole("button", { name: "Performance", exact: true }).click();
    await expect(studioCanvas(page, "2d")).toBeVisible();

    const playAlongButton = page.getByRole("button", { name: "Play along", exact: true });
    await playAlongButton.click();
    const playAlongControls = page.getByLabel("Play along practice controls");
    await expect(playAlongControls.getByText(/Step 1 of \d+/)).toBeVisible();
    await playAlongControls.getByRole("button", { name: "Next step", exact: true }).click();
    await expect(playAlongControls.getByText(/Step 2 of \d+/)).toBeVisible();
    const playAlongLibraryDialog = await openLibrary(page);
    await playAlongLibraryDialog.getByRole("button", { name: /Close/ }).click();
    await expect(playAlongControls.getByText(/Step 2 of \d+/)).toBeVisible();
    await expect(playAlongControls.getByText(/Step 1 of \d+/)).toHaveCount(0);
    await page.getByRole("button", { name: "Performance", exact: true }).click();
    await expect(playAlongControls).toHaveCount(0);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => getSeekValue(page), { timeout: 15_000 }).toBeGreaterThan(0.1);
    await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", "Pause", { timeout: 10_000 });
    const originalProjectId = await getProjectId(page);
    expect(originalProjectId).toBeTruthy();

    const dialog = await openLibrary(page);
    await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", "Play", { timeout: 10_000 });
    await page.waitForTimeout(250);
    const pausedPosition = await getSeekValue(page);
    await page.waitForTimeout(500);
    expect(Math.abs((await getSeekValue(page)) - pausedPosition)).toBeLessThan(0.02);

    await dialog.getByRole("button", { name: /My folder/ }).click();
    await expect(dialog.getByRole("button", { name: /My folder/ })).toHaveAttribute("aria-pressed", "true");
    const folderInput = dialog.locator('input[type="file"][webkitdirectory]');
    await expect(folderInput).toHaveCount(1);
    await dialog.locator("button").filter({ hasText: "Connect folder…" }).click();
    await folderInput.setInputFiles(melodyFolder);
    await expect(dialog.getByText("2 indexed · 0 reused · 1 errors", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => libraryWorkerUrls.length).toBeGreaterThanOrEqual(3);

    const midiRow = getMelodyRows(dialog).filter({ hasText: "Local MIDI Study" });
    const xmlRow = getMelodyRows(dialog).filter({ hasText: "Local XML Study" });
    await expect(midiRow).toHaveCount(1);
    await expect(xmlRow).toHaveCount(1);
    await expect(midiRow).toContainText("0:08");
    await expect(midiRow).toContainText("1 notes");
    await expect(midiRow).toContainText(/(?:Beginner|Intermediate|Advanced|Virtuoso) · Difficulty \d\.\d\/10/);
    await expect(xmlRow).toContainText("1 notes");
    await expect(dialog.getByText("Some files could not be indexed (1)")).toBeVisible();
    await dialog.locator("details summary").click();
    await expect(dialog.getByText("Nested/Broken.mid", { exact: true })).toBeVisible();

    const categoryGroup = dialog.getByRole("group", { name: "Folder category", exact: true });
    await categoryGroup.getByRole("button", { name: "Nested (1)", exact: true }).click();
    await expect(midiRow).toBeVisible();
    await expect(xmlRow).toHaveCount(0);
    await categoryGroup.getByRole("button", { name: /All folders/ }).click();

    const favoriteButton = midiRow.getByRole("button", { name: "Add to favorites: Local MIDI Study", exact: true });
    await favoriteButton.click();
    await expect(midiRow.getByRole("button", { name: "Remove from favorites: Local MIDI Study", exact: true })).toHaveAttribute("aria-pressed", "true");

    const firstSnapshot = await readLocalLibrarySnapshot(page);
    expect(firstSnapshot?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: "Nested/Local MIDI Study.mid",
        title: "Local MIDI Study",
        sourceFormat: "midi",
        firstLevelFolder: "Nested",
        noteCount: 1,
      }),
      expect.objectContaining({
        relativePath: "MusicXML/Local XML Study.musicxml",
        title: "Local XML Study",
        sourceFormat: "musicxml",
        firstLevelFolder: "MusicXML",
        noteCount: 1,
      }),
    ]));
    expect(firstSnapshot?.sources[0]?.lastScanErrorCount).toBe(1);

    // Add many files after the committed scan, cancel the rescan, and prove
    // the previously committed snapshot and active project remain unchanged.
    const bulkFolder = join(melodyFolder, "Bulk");
    await mkdir(bulkFolder, { recursive: true });
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      writeFile(join(bulkFolder, `Cancel ${String(index).padStart(3, "0")}.mid`), makeMidi(1)),
    ));
    await dialog.getByRole("button", { name: "Refresh folder", exact: true }).click();
    await folderInput.setInputFiles(melodyFolder);
    const cancelScan = dialog.getByRole("button", { name: "Cancel scan", exact: true });
    await expect(cancelScan).toBeVisible();
    await cancelScan.click();
    await expect(cancelScan).toHaveCount(0);
    await expect(getMelodyRows(dialog)).toHaveCount(2);
    const afterCancelSnapshot = await readLocalLibrarySnapshot(page);
    expect(afterCancelSnapshot?.revision).toBe(firstSnapshot?.revision);
    expect(await getProjectId(page)).toBe(originalProjectId);

    await rm(bulkFolder, { recursive: true, force: true });
    await dialog.getByRole("button", { name: "Refresh folder", exact: true }).click();
    await folderInput.setInputFiles(melodyFolder);
    await expect(dialog.getByText("0 indexed · 2 reused · 1 errors", { exact: true })).toBeVisible({ timeout: 90_000 });
    await dialog.locator("details summary").click();
    await expect(dialog.getByText("Nested/Broken.mid", { exact: true })).toBeVisible();
    const rescannedSnapshot = await readLocalLibrarySnapshot(page);
    expect(rescannedSnapshot?.revision).toBeGreaterThan(firstSnapshot?.revision ?? -1);
    expect(rescannedSnapshot?.entries.map((entry) => entry.id).sort()).toEqual(firstSnapshot?.entries.map((entry) => entry.id).sort());
    expect(rescannedSnapshot?.sources[0]?.lastScanErrorCount).toBe(1);
    expect(await getProjectId(page)).toBe(originalProjectId);

    const filterGroup = dialog.getByRole("group", { name: "Filter by tag", exact: true });
    const favoritesFilter = filterGroup.getByRole("button", { name: /Favorites \(1\)/ });
    await favoritesFilter.click();
    await expect(getMelodyRows(dialog)).toHaveCount(1);
    await expect(midiRow).toBeVisible();
    await expect(xmlRow).toHaveCount(0);
    await favoritesFilter.click();
    await expect(getMelodyRows(dialog)).toHaveCount(2);

    const audioContextsBeforePreview = await page.evaluate(() =>
      (window as Window & { __localLibraryAudioContexts?: AudioContext[] }).__localLibraryAudioContexts?.length ?? 0,
    );
    const previewButton = midiRow.locator('button[aria-label="Preview: Local MIDI Study"], button[aria-label="Stop preview: Local MIDI Study"]');
    await previewButton.click();
    await expect(previewButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => page.evaluate(() =>
      (window as Window & { __localLibraryAudioContexts?: AudioContext[] }).__localLibraryAudioContexts?.length ?? 0,
    )).toBeGreaterThan(audioContextsBeforePreview);
    await expect.poll(async () => page.evaluate(() =>
      (window as Window & { __localLibraryAudioContexts?: AudioContext[] }).__localLibraryAudioContexts?.at(-1)?.state,
    )).toBe("running");
    expect(await getProjectId(page)).toBe(originalProjectId);

    await dialog.getByRole("button", { name: /Close/ }).click();
    await expect.poll(async () => page.evaluate(() =>
      (window as Window & { __localLibraryAudioContexts?: AudioContext[] }).__localLibraryAudioContexts?.at(-1)?.state,
    )).toBe("closed");
    expect(await getProjectId(page)).toBe(originalProjectId);
    await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", "Pause", { timeout: 10_000 });
    await expect.poll(() => getSeekValue(page), { timeout: 10_000 }).toBeGreaterThan(pausedPosition + 0.2);

    const workerCountBeforeReload = libraryWorkerUrls.length;
    await page.reload();
    await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });
    const persistedDialog = await openLibrary(page);
    await expect(persistedDialog.getByRole("button", { name: /My folder/ })).toHaveAttribute("aria-pressed", "true");
    await expect(getMelodyRows(persistedDialog)).toHaveCount(2);
    await expect(persistedDialog.getByRole("button", { name: "Remove from favorites: Local MIDI Study", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => libraryWorkerUrls.length).toBe(workerCountBeforeReload);
    const persistedSnapshot = await readLocalLibrarySnapshot(page);
    expect(persistedSnapshot?.entries.map((entry) => entry.id).sort()).toEqual(rescannedSnapshot?.entries.map((entry) => entry.id).sort());
    expect(persistedSnapshot?.sources[0]?.lastScanErrorCount).toBe(1);

    const recentFilter = persistedDialog.getByRole("group", { name: "Filter by tag", exact: true }).getByRole("button", { name: "Recent (0)", exact: true });
    await recentFilter.click();
    await expect(persistedDialog.getByText("No recently opened melodies yet.", { exact: true })).toBeVisible();
    await recentFilter.click();
    await persistedDialog.getByRole("group", { name: "Filter by tag", exact: true }).getByRole("button", { name: /All tags/ }).click();
    await persistedDialog.getByRole("button", { name: /Close/ }).click();

    await page.locator("#midi-file").setInputFiles(activeMidiPath);
    await expectStudioCanvas(page, 120_000);
    const replacementGuardProject = await settledStudio(page, 0);
    const guardProjectId = replacementGuardProject.result.projectId;
    await page.getByRole("button", { name: "Performance", exact: true }).click();
    await expect(studioCanvas(page, "2d")).toBeVisible();

    await (await openLibrary(page)).getByRole("button", { name: "Open Local MIDI Study", exact: true }).click();
    const cancelGuard = page.getByRole("alertdialog", { name: "Unsaved changes", exact: true });
    await expect(cancelGuard).toBeVisible({ timeout: 90_000 });
    expect(await getProjectId(page)).toBe(guardProjectId);
    await cancelGuard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(cancelGuard).toHaveCount(0);

    const afterCancelDialog = await openLibrary(page);
    const recentAfterCancel = afterCancelDialog.getByRole("group", { name: "Filter by tag", exact: true }).getByRole("button", { name: "Recent (0)", exact: true });
    await recentAfterCancel.click();
    await expect(afterCancelDialog.getByText("No recently opened melodies yet.", { exact: true })).toBeVisible();
    await recentAfterCancel.click();
    await afterCancelDialog.getByRole("group", { name: "Filter by tag", exact: true }).getByRole("button", { name: /All tags/ }).click();

    await afterCancelDialog.getByRole("button", { name: "Open Local MIDI Study", exact: true }).click();
    const commitGuard = page.getByRole("alertdialog", { name: "Unsaved changes", exact: true });
    await expect(commitGuard).toBeVisible({ timeout: 90_000 });
    expect(await getProjectId(page)).toBe(guardProjectId);
    await commitGuard.getByRole("button", { name: "Discard and open", exact: true }).click();
    await expect.poll(() => getProjectId(page), { timeout: 120_000 }).not.toBe(guardProjectId);
    const openedLocal = await settledStudio(page, 0);
    expect(openedLocal.result.document!.notes).toHaveLength(1);

    const committedDialog = await openLibrary(page);
    const recentAfterCommit = committedDialog.getByRole("group", { name: "Filter by tag", exact: true }).getByRole("button", { name: "Recent (1)", exact: true });
    await recentAfterCommit.click();
    await expect(getMelodyRows(committedDialog)).toHaveCount(1);
    await expect(getMelodyRows(committedDialog)).toContainText("Local MIDI Study");
    await recentAfterCommit.click();

    await committedDialog.getByRole("button", { name: /^Built-in/ }).click();
    await expect(getMelodyRows(committedDialog).first()).toBeVisible({ timeout: 60_000 });
    const tierFilters = committedDialog.getByRole("group", { name: "Filter by tag", exact: true });
    await tierFilters.getByRole("button", { name: /Virtuoso/ }).click();
    await expect(committedDialog.getByRole("button", { name: "Open Rock Solid Blues", exact: true })).toBeVisible();

    await testInfo.attach("native-directory-picker-manual-evidence.txt", {
      contentType: "text/plain",
      body: "The fallback test deliberately disabled showDirectoryPicker. A separate OPFS test uses a real browser directory handle to verify IndexedDB cloning and rescan. Native picker UI and user-selected folder permission/re-grant remain manual evidence.",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("real OPFS folder handles survive IndexedDB reload and rescan", async ({ page }) => {
  test.setTimeout(120_000);
  const opfsDirectoryName = `codex-local-library-${Date.now()}`;
  await installBrowserInstrumentation(page, opfsDirectoryName);

  try {
    await page.goto("/?empty=true");
    await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });
    const fixtureMidi = Array.from(makeMidi(1));
    const createdDirectory = await page.evaluate(async ({ directoryName, midiBytes }) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(directoryName, { create: true });
      const nested = await directory.getDirectoryHandle("Collection", { create: true });
      const midiFile = await nested.getFileHandle("OPFS Directory Study.mid", { create: true });
      const writable = await midiFile.createWritable();
      await writable.write(Uint8Array.from(midiBytes));
      await writable.close();
      return { kind: directory.kind, name: directory.name };
    }, { directoryName: opfsDirectoryName, midiBytes: fixtureMidi });
    expect(createdDirectory).toEqual({ kind: "directory", name: opfsDirectoryName });

    const dialog = await openLibrary(page);
    await dialog.getByRole("button", { name: /My folder/ }).click();
    await expect(dialog.getByRole("button", { name: /My folder/ })).toHaveAttribute("aria-pressed", "true");
    await dialog.locator("button").filter({ hasText: "Connect folder…" }).click();
    await expect(dialog.getByText("1 indexed · 0 reused · 0 errors", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(getMelodyRows(dialog).filter({ hasText: "OPFS Directory Study" })).toContainText("Collection/OPFS Directory Study.mid");

    const firstHandles = await readPersistedDirectoryHandles(page);
    expect(firstHandles).toEqual([expect.objectContaining({
      kind: "directory",
      name: opfsDirectoryName,
      directoryHandleName: opfsDirectoryName,
      children: [{ kind: "directory", name: "Collection" }],
    })]);

    await page.reload();
    await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });
    const restoredDialog = await openLibrary(page);
    await expect(getMelodyRows(restoredDialog).filter({ hasText: "OPFS Directory Study" })).toHaveCount(1);
    const restoredHandles = await readPersistedDirectoryHandles(page);
    expect(restoredHandles).toEqual(firstHandles);

    await restoredDialog.getByRole("button", { name: "Refresh folder", exact: true }).click();
    await expect(restoredDialog.getByText("0 indexed · 1 reused · 0 errors", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(getMelodyRows(restoredDialog).filter({ hasText: "OPFS Directory Study" })).toHaveCount(1);
  } finally {
    await page.evaluate(async (directoryName) => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(directoryName, { recursive: true });
      } catch {
        // Keep cleanup idempotent if setup failed before creating the OPFS directory.
      }
    }, opfsDirectoryName).catch(() => undefined);
  }
});
