import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { installOpfsSavePicker, openVideoExportModal, readOpfsOutput } from "./media-export-helpers";
import {
  committedStudioSettings,
  configureStudioTestOutput,
  expectStudioCanvas,
  settledStudio,
  studioCanvas,
  waitForLoadingToClear,
} from "./studio-helpers";

type HandModelId = "anatomical" | "webxr" | "anatomical-improved" | "testing";
type CameraId = "concert" | "overhead" | "pov" | "side_arch";

type HandDiagnostics = {
  requestedModel: HandModelId;
  loadedModel: HandModelId;
  requestedLod: number | null;
  loadedLod: number | null;
  state: string;
  error: string | null;
  triangles: number;
  cachedAssetCount: number;
  cachedGlbAssetCount: number;
  cachedGlbBytes: number;
  cachedTextureCount: number;
  estimatedTextureBaseBytes: number;
  cachedAssetBytes: number;
  activeContactTargets: Array<{ finger: number; pitch: number }>;
};

type HandModelDiagnostics = {
  left: HandDiagnostics;
  right: HandDiagnostics;
  renderer: {
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
    renderedFramesWindow: number;
    renderWindowMs: number;
    renderedFramesTotal: number;
    handUpdateFramesWindow: number;
    handUpdateMeanMs: number;
    handUpdateLastMs: number;
    handUpdateFramesTotal: number;
  };
};

type BrowserSnapshot = {
  result: {
    projectId: string;
    revision: number;
    fingeringPlan?: {
      planId: string;
      assignments?: Array<{ noteId: string; hand: "left" | "right"; finger: number | null }>;
    } | null;
    performancePlan?: {
      planId: string;
      fingeringPlanId: string;
      events?: Array<{ type: string; timeSeconds: number; pitch?: number; noteId?: string }>;
    } | null;
    motionPlan?: { planId: string; performancePlanId: string; poses: unknown[] } | null;
  };
  draftPlan: { inputRevision?: number };
  viewMode?: string;
  pending: boolean;
  currentTimeSeconds?: number;
  scene?: {
    handModelDiagnostics?: HandModelDiagnostics | null;
    keyCount?: number;
    viewTime: number;
  };
};

type SourceViewerResult = {
  status: "ready" | "error";
  sourceMode: "manifest-lod0" | "draft-lod1" | "texture-compare-lod0";
  assetUrls: string[];
  hands: Record<"left" | "right", { weightedVertices: number; skeletonBones: number; triangleCount: number }>;
  textureComparison?: { reference: Record<string, unknown>; candidateBase: string };
  error?: string;
};

type ExportReadinessRecord = {
  projectedNotes: Array<{ noteId: string; pitch: number; hand: "left" | "right"; finger: number | null }>;
  ready: HandModelDiagnostics;
  firstRenderedFrame: HandModelDiagnostics | null;
  contactTargetFrames: HandModelDiagnostics[];
};

type PosedHandProbe = {
  hand: "left" | "right";
  poseTimeSeconds: number | null;
  pose: unknown;
  appliedHoverLift: number | null;
  reconstructedThumbChainWorldInches: number[][];
  reconstructedFingerChainsWorldInches: Record<string, number[][]>;
  reconstructedHandFrame: {
    wristR: number[];
    wristU: number[];
    wristCenter: number[];
    armEnd: number[];
    palmNormal: number[];
    wristWidthIn: number;
    chainsWorldInches: Record<string, number[][]>;
  };
  palmarDistalSupportWorldYByFinger: Record<string, {
    vertexCount: number;
    minimumWorldY: number;
    fifthPercentileWorldY: number;
    medianWorldY: number;
  }>;
  allBones: Record<string, {
    position: number[];
    quaternion: number[];
    scale: number[];
    worldMatrix: number[];
    bindPositionMeters: number[];
    bindQuaternion: number[];
    localUpInWrist: number[];
    localLateralInWrist: number[];
    bindLengthIn: number;
  }>;
  thumbBones: Record<string, {
    position: number[];
    quaternion: number[];
    scale: number[];
    worldMatrix: number[];
    bindLengthIn: number | null;
  }>;
};

type PosedSceneProbe = {
  viewTime: number;
  activePitches: number[];
  hands: Record<"left" | "right", PosedHandProbe | null>;
};

type ActualKeyFootprintProbe = {
  hand: "left" | "right";
  pitch: number;
  finger: number;
  keyDepressionRadians: number | null;
  eligibleDistalVertices: number;
  verticesOnAssignedKeyTop: number;
  gapMillimeters: {
    minimum: number | null;
    p01: number | null;
    p05: number | null;
    median: number | null;
    maximum: number | null;
  };
  penetrationCounts: { belowSurface: number; beyond1mm: number; beyond3mm: number };
};

type LiveSceneNoteRow = {
  noteId: string;
  pitch: number;
  hand: "left" | "right";
  finger: number | null;
  startSeconds: number;
  endSeconds: number;
};

type LiveNoteSourceCapture = {
  requestedModel: HandModelId;
  currentTransportTime: number;
  performancePlanPresent: boolean;
  noteSource: "renderedNoteTimings" | "scene.notes";
  sceneNotes: LiveSceneNoteRow[];
  renderedNoteTimings: LiveSceneNoteRow[];
  selectedNoteSource: LiveSceneNoteRow[];
  activeNoteSource: LiveSceneNoteRow[];
  activeContactTargets: {
    left: Array<{ finger: number; pitch: number }>;
    right: Array<{ finger: number; pitch: number }>;
  };
};

type InstrumentablePianoScene3D = {
  setNotes(notes: Array<{ noteId: string; pitch: number; hand: "left" | "right"; finger: number | null }>): void;
  waitForHandModelReady(): Promise<void>;
  renderFrame(): void;
  getHandModelDiagnostics(): HandModelDiagnostics;
};

declare global {
  interface Window {
    __anatomicalSourceViewerResult?: SourceViewerResult;
    __anatomicalExportReadiness?: ExportReadinessRecord[];
    __anatomicalPoseProbe?: PosedSceneProbe | null;
    __anatomicalLiveNoteSourceProbe?: LiveNoteSourceCapture[];
    __anatomicalActualKeyFootprintProbe?: () => ActualKeyFootprintProbe[];
  }
}

const models: readonly HandModelId[] = ["anatomical", "webxr", "anatomical-improved"];
const cameras: readonly CameraId[] = ["concert", "overhead", "pov", "side_arch"];
const demoMidiPath = fileURLToPath(new URL("../fixtures/midi/tracked-demo-song.mid", import.meta.url));

async function loadTwoHandDemoSong(page: Page) {
  const base = process.env.PIANOMOTION_PREVIEW_BASE ?? "/";
  await page.goto(base.includes("?") ? `${base}&empty=true` : `${base}?empty=true`);
  await expect(page).toHaveTitle("PianoMotion Studio");
  await waitForLoadingToClear(page);
  const midiInput = page.locator("#midi-file");
  await expect(midiInput).toHaveCount(1, { timeout: 30_000 });
  const demoButton = page.getByRole("button", { name: "Play demo song", exact: true });
  if (await demoButton.count()) await expect(demoButton).toBeEnabled({ timeout: 30_000 });
  await configureStudioTestOutput(page);
  await midiInput.setInputFiles(demoMidiPath);
  await expectStudioCanvas(page);
  return settledStudio(page, 0);
}

function makeShortTwoHandMidi(): Buffer {
  const track = Buffer.from([
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 BPM
    0x00, 0x90, 48, 88, // left C3
    0x00, 0x91, 72, 88, // right C5
    0x83, 0x60, 0x80, 48, 0x00, // one beat: release left
    0x00, 0x81, 72, 0x00, // one beat: release right
    0x83, 0x60, 0xff, 0x2f, 0x00, // one second total
  ]);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0]);
  const trackHeader = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff]);
  return Buffer.concat([header, trackHeader, track]);
}

type MatrixMidiNote = { section: string; pitch: number; startTick: number; durationTicks: number };

const articulationMatrixNotes: MatrixMidiNote[] = [
  { section: "single-white", pitch: 64, startTick: 0, durationTicks: 384 },
  { section: "single-black", pitch: 61, startTick: 960, durationTicks: 384 },
  ...[60, 64, 67].map(pitch => ({ section: "chord", pitch, startTick: 1920, durationTicks: 384 })),
  ...[48, 60].map(pitch => ({ section: "octave", pitch, startTick: 2880, durationTicks: 384 })),
  ...[60, 62, 64, 65, 67, 69, 71, 72].map((pitch, index) => ({
    section: "scale",
    pitch,
    startTick: 3840 + index * 240,
    durationTicks: 192,
  })),
  ...[72, 71, 69, 67, 65, 64, 62, 60].map((pitch, index) => ({
    section: "fast-run",
    pitch,
    startTick: 6240 + index * 120,
    durationTicks: 96,
  })),
];

const articulationMatrixWindows = {
  "single-white": { startSeconds: 0, endSeconds: 0.9 },
  "single-black": { startSeconds: 0.9, endSeconds: 1.9 },
  chord: { startSeconds: 1.9, endSeconds: 2.9 },
  octave: { startSeconds: 2.9, endSeconds: 3.9 },
  scale: { startSeconds: 3.9, endSeconds: 6.15 },
  "fast-run": { startSeconds: 6.4, endSeconds: 7.6 },
} as const;

function encodeMidiVariableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let remaining = Math.floor(value / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
    bytes.unshift((remaining & 0x7f) | 0x80);
  }
  return bytes;
}

function makeArticulationMatrixMidi(): Buffer {
  const trackEvents: Array<{ tick: number; order: number; bytes: number[] }> = [
    { tick: 0, order: -1, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }, // 120 BPM
  ];
  for (const note of articulationMatrixNotes) {
    trackEvents.push(
      { tick: note.startTick, order: 1, bytes: [0x90, note.pitch, 88] },
      { tick: note.startTick + note.durationTicks, order: 0, bytes: [0x80, note.pitch, 0] },
    );
  }
  trackEvents.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const trackBytes: number[] = [];
  let previousTick = 0;
  for (const event of trackEvents) {
    trackBytes.push(...encodeMidiVariableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  trackBytes.push(0x00, 0xff, 0x2f, 0x00);
  const track = Buffer.from(trackBytes);
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0]);
  const trackHeader = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff]);
  return Buffer.concat([header, trackHeader, track]);
}

async function loadShortTwoHandSong(page: Page) {
  const base = process.env.PIANOMOTION_PREVIEW_BASE ?? "/";
  await page.goto(base.includes("?") ? `${base}&empty=true` : `${base}?empty=true`);
  await expect(page).toHaveTitle("PianoMotion Studio");
  await waitForLoadingToClear(page);
  const midiInput = page.locator("#midi-file");
  await expect(midiInput).toHaveCount(1, { timeout: 30_000 });
  const demoButton = page.getByRole("button", { name: "Play demo song", exact: true });
  if (await demoButton.count()) await expect(demoButton).toBeEnabled({ timeout: 30_000 });
  await configureStudioTestOutput(page);
  await midiInput.setInputFiles({
    name: "anatomical-improved-export-smoke.mid",
    mimeType: "audio/midi",
    buffer: makeShortTwoHandMidi(),
  });
  await expectStudioCanvas(page);
  const snapshot = await settledStudio(page, 0);
  expect(snapshot.result.motionPlan?.poses.length ?? 0).toBeGreaterThan(0);
  return snapshot;
}

async function loadArticulationMatrixSong(page: Page) {
  const base = process.env.PIANOMOTION_PREVIEW_BASE ?? "/";
  await page.goto(base.includes("?") ? `${base}&empty=true` : `${base}?empty=true`);
  await expect(page).toHaveTitle("PianoMotion Studio");
  await waitForLoadingToClear(page);
  const midiInput = page.locator("#midi-file");
  await expect(midiInput).toHaveCount(1, { timeout: 30_000 });
  const demoButton = page.getByRole("button", { name: "Play demo song", exact: true });
  if (await demoButton.count()) await expect(demoButton).toBeEnabled({ timeout: 30_000 });
  await configureStudioTestOutput(page);
  await midiInput.setInputFiles({
    name: "anatomical-improved-articulation-matrix.mid",
    mimeType: "audio/midi",
    buffer: makeArticulationMatrixMidi(),
  });
  await expectStudioCanvas(page);
  const snapshot = await settledStudio(page, 0);
  expect(snapshot.result.motionPlan?.poses.length ?? 0).toBeGreaterThan(0);
  return snapshot;
}

async function browserSnapshot(page: Page) {
  return page.evaluate(() => {
    const snapshot = (window as unknown as { __playerSnapshot?: BrowserSnapshot }).__playerSnapshot;
    if (!snapshot) return null;
    return {
      projectId: snapshot.result.projectId,
      revision: snapshot.result.revision,
      performancePlanId: snapshot.result.performancePlan?.planId ?? null,
      motionPoseCount: snapshot.result.motionPlan?.poses.length ?? 0,
      pending: snapshot.pending,
      currentTimeSeconds: snapshot.currentTimeSeconds ?? null,
      sceneTime: snapshot.scene?.viewTime ?? null,
      handModelDiagnostics: snapshot.scene?.handModelDiagnostics ?? null,
    };
  });
}

async function selectHandModel(page: Page, model: HandModelId) {
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  const select = preferences.locator("#settings-hand-model");
  await expect(select.locator("option")).toHaveCount(4);
  await select.selectOption(model);
  await expect.poll(async () => (await committedStudioSettings(page)).handModel).toBe(model);
  await preferences.getByRole("button", { name: "Done", exact: true }).click();
}

async function expectLoadedModel(page: Page, model: HandModelId) {
  await page.waitForFunction(requestedModel => {
    const diagnostics = window.__playerSnapshot?.scene?.handModelDiagnostics;
    if (!diagnostics) return false;
    const hands = [diagnostics.left, diagnostics.right];
    const ready = hands.every(hand => hand.requestedModel === requestedModel &&
      hand.loadedModel === requestedModel && hand.state === "ready" && hand.error === null);
    const failed = hands.some(hand => hand.requestedModel === requestedModel &&
      (hand.state === "error" || hand.error !== null));
    return ready || failed;
  }, model, { timeout: 90_000, polling: 250 });
  const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
  expect(diagnostics ? [diagnostics.left, diagnostics.right].map(hand => ({
    requestedModel: hand.requestedModel,
    loadedModel: hand.loadedModel,
    state: hand.state,
    error: hand.error,
  })) : null).toEqual([
    { requestedModel: model, loadedModel: model, state: "ready", error: null },
    { requestedModel: model, loadedModel: model, state: "ready", error: null },
  ]);

  for (const hand of [diagnostics!.left, diagnostics!.right]) {
    if (model === "anatomical-improved" || model === "testing") {
      expect(hand.loadedLod).toBeGreaterThanOrEqual(0);
      expect(hand.loadedLod).toBeLessThanOrEqual(2);
      expect(hand.requestedLod).toBe(hand.loadedLod);
    } else {
      expect(hand.loadedLod).toBeNull();
      expect(hand.requestedLod).toBeNull();
    }
  }
}

async function setCamera(page: Page, camera: CameraId) {
  const mobileSelect = page.getByRole("combobox", { name: "3D camera preset", exact: true });
  if (await mobileSelect.isVisible()) {
    await mobileSelect.selectOption(camera);
  } else {
    const cameraButtons = page.getByRole("group", { name: "3D camera presets", exact: true }).locator("button");
    await cameraButtons.nth(cameras.indexOf(camera)).click();
  }
}

async function sampleFrameIntervals(page: Page, count: number) {
  return page.evaluate(async frameCount => {
    const startedAt = performance.now();
    const intervals: number[] = [];
    let previous: number | null = null;
    await new Promise<void>(resolve => {
      const next = (timestamp: number) => {
        if (previous !== null) intervals.push(timestamp - previous);
        previous = timestamp;
        if (intervals.length >= frameCount) resolve();
        else requestAnimationFrame(next);
      };
      requestAnimationFrame(next);
    });
    const sorted = [...intervals].sort((a, b) => a - b);
    const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))] ?? 0;
    return {
      sampleCount: intervals.length,
      elapsedMs: performance.now() - startedAt,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      observedMedianFps: percentile(0.5) > 0 ? 1000 / percentile(0.5) : 0,
    };
  }, count);
}

async function seekToTime(page: Page, time: number) {
  const seek = page.getByRole("slider", { name: "Seek position", exact: true });
  await seek.evaluate((element, target) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(target));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, time);
  await expect.poll(async () => (await browserSnapshot(page))?.currentTimeSeconds ?? null, { timeout: 10_000 })
    .toBeCloseTo(time, 1);
}

async function sampleAnimatedRender(page: Page, count: number) {
  const play = page.locator("#player-play-button");
  const seek = page.getByRole("slider", { name: "Seek position", exact: true });
  const startTime = Number(await seek.inputValue());
  await play.click();
  await expect(play).toContainText("Pause");
  await expect.poll(() => seek.inputValue().then(Number), { timeout: 15_000, intervals: [250] })
    .toBeGreaterThan(startTime + 0.4);
  await page.waitForTimeout(500); // warm-up while real playback updates the 3D scene
  const before = await browserSnapshot(page);
  const intervals = await sampleFrameIntervals(page, count);
  const after = await browserSnapshot(page);
  await play.click();
  await expect(play).toContainText("Play");
  const playbackSeconds = (after?.currentTimeSeconds ?? startTime) - (before?.currentTimeSeconds ?? startTime);
  const beforeRenderer = before?.handModelDiagnostics?.renderer;
  const afterRenderer = after?.handModelDiagnostics?.renderer;
  const renderFrames = beforeRenderer && afterRenderer
    ? afterRenderer.renderedFramesTotal - beforeRenderer.renderedFramesTotal
    : null;
  const handUpdateFrames = beforeRenderer && afterRenderer
    ? afterRenderer.handUpdateFramesTotal - beforeRenderer.handUpdateFramesTotal
    : null;
  expect(playbackSeconds).toBeGreaterThan(0.25);
  expect(beforeRenderer, "renderer counters must exist before animated sampling").toBeTruthy();
  expect(afterRenderer, "renderer counters must exist after animated sampling").toBeTruthy();
  expect(renderFrames ?? 0, "actual renderer.render calls must advance during playback").toBeGreaterThan(0);
  expect(handUpdateFrames ?? 0, "actual hand update calls must advance during playback").toBeGreaterThan(0);
  return {
    startTimeSeconds: startTime,
    measuredPlaybackSeconds: playbackSeconds,
    intervals,
    renderedFrames: renderFrames,
    actualRendererFps: renderFrames !== null && intervals.elapsedMs > 0
      ? renderFrames * 1000 / intervals.elapsedMs
      : null,
    handUpdateFrames,
    rendererBefore: before?.handModelDiagnostics?.renderer ?? null,
    rendererAfter: after?.handModelDiagnostics?.renderer ?? null,
    handsAfter: after?.handModelDiagnostics ? {
      left: after.handModelDiagnostics.left,
      right: after.handModelDiagnostics.right,
    } : null,
  };
}

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const path = testInfo.outputPath(name);
  await studioCanvas(page, "3d").screenshot({ path });
  const reviewImage = name.includes("-desktop.png") || name.includes("-close-") || name.includes("-mobile-") ||
    (name.startsWith("anatomical-improved-") && (name.includes("-animation-") || name.includes("-seek-")));
  if (reviewImage) await testInfo.attach(name.replace(/\.png$/i, ""), { path, contentType: "image/png" });
}

async function selectAndWaitForImprovedHand(page: Page) {
  await selectHandModel(page, "anatomical-improved");
  await expectLoadedModel(page, "anatomical-improved");
}

async function installPosedThumbProbe(page: Page, options: { singleCapture?: boolean } = {}) {
  await page.evaluate(async ({ singleCapture }) => {
    type ProbeBone = {
      name?: string;
      position: { x: number; y: number; z: number };
      quaternion: { x: number; y: number; z: number; w: number };
      scale: { x: number; y: number; z: number };
      matrixWorld: { elements: ArrayLike<number> };
    };
    type ProbeVector = {
      x: number;
      y: number;
      z: number;
      [Symbol.iterator](): Iterator<number>;
      set(x: number, y: number, z: number): ProbeVector;
      addScaledVector(value: { x: number; y: number; z: number }, scale: number): ProbeVector;
      applyMatrix4(matrix: { elements: ArrayLike<number> }): ProbeVector;
    };
    type ProbeAttribute = {
      count: number;
      getX(index: number): number;
      getY(index: number): number;
      getZ(index: number): number;
      getComponent(index: number, component: number): number;
    };
    type ProbeSkinnedMesh = {
      geometry: { attributes: { position: ProbeAttribute; skinIndex: ProbeAttribute; skinWeight: ProbeAttribute } };
      skeleton: { bones: Array<{ name: string }> };
      applyBoneTransform(index: number, target: ProbeVector): ProbeVector;
      updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
      localToWorld(target: ProbeVector): ProbeVector;
    };
    type ProbeHand = {
      lastPose?: { hand: "left" | "right"; transportTimeSeconds: number };
      lastHoverLift?: number;
      rig?: {
        bonesByName?: Map<string, {
          bone: ProbeBone;
          bindPositionM: { x: number; y: number; z: number };
          bindQuaternion: { x: number; y: number; z: number; w: number };
          localUpInWrist: { x: number; y: number; z: number };
          localLateralInWrist: { x: number; y: number; z: number };
          bindLengthIn: number;
        }>;
        skinnedMesh?: ProbeSkinnedMesh;
      };
    };
    type ProbeScene = {
      scene3D?: { leftHand3D?: ProbeHand; rightHand3D?: ProbeHand };
      lastActiveNotes?: number[];
    };
    type ProbeWindow = Window & {
      __anatomicalPoseProbe?: PosedSceneProbe | null;
      __anatomicalPoseProbeCaptureRequested?: boolean;
    };
    type Snapshot = { viewTime: number };
    const moduleUrl = new URL("/src/render/pianoScene.ts", location.origin).href;
    const module = await import(/* @vite-ignore */ moduleUrl) as {
      PianoScene: { prototype: { getGeometrySnapshot(this: unknown): Snapshot } };
    };
    const rigModuleUrl = new URL("/src/render3d/handRigBuilder.ts", location.origin).href;
    const rigModule = await import(/* @vite-ignore */ rigModuleUrl) as {
      reconstructHand3D: (pose: { hand: "left" | "right"; transportTimeSeconds: number }, hoverLift?: number) => {
        wristR: { x: number; y: number; z: number };
        wristU: { x: number; y: number; z: number };
        wristCenter: { x: number; y: number; z: number };
        armEnd: { x: number; y: number; z: number };
        palmNormal: { x: number; y: number; z: number };
        wristWidthIn: number;
        chains: Record<number, Array<{ x: number; y: number; z: number }> | undefined>;
      };
    };
    const prototype = module.PianoScene.prototype;
    const original = prototype.getGeometrySnapshot;
    const probeWindow = window as ProbeWindow;
    if (singleCapture) {
      probeWindow.__anatomicalPoseProbe = null;
      probeWindow.__anatomicalPoseProbeCaptureRequested = false;
    }
    const thumbBoneNames = [
      "thumb-metacarpal",
      "thumb-phalanx-proximal",
      "thumb-phalanx-distal",
      "thumb-tip",
    ];
    const vector = (value: { x: number; y: number; z: number }) => [value.x, value.y, value.z];
    const createProbeVector = (x = 0, y = 0, z = 0): ProbeVector => ({
      x,
      y,
      z,
      *[Symbol.iterator]() { yield this.x; yield this.y; yield this.z; },
      set(nextX, nextY, nextZ) { this.x = nextX; this.y = nextY; this.z = nextZ; return this; },
      addScaledVector(value, scale) {
        this.x += value.x * scale;
        this.y += value.y * scale;
        this.z += value.z * scale;
        return this;
      },
      applyMatrix4(matrix) {
        const elements = matrix.elements;
        const reciprocalW = 1 / (elements[3]! * this.x + elements[7]! * this.y + elements[11]! * this.z + elements[15]!);
        const nextX = (elements[0]! * this.x + elements[4]! * this.y + elements[8]! * this.z + elements[12]!) * reciprocalW;
        const nextY = (elements[1]! * this.x + elements[5]! * this.y + elements[9]! * this.z + elements[13]!) * reciprocalW;
        const nextZ = (elements[2]! * this.x + elements[6]! * this.y + elements[10]! * this.z + elements[14]!) * reciprocalW;
        this.x = nextX;
        this.y = nextY;
        this.z = nextZ;
        return this;
      },
    });
    prototype.getGeometrySnapshot = function (this: unknown): Snapshot {
      const snapshot = original.call(this);
      if (singleCapture && !probeWindow.__anatomicalPoseProbeCaptureRequested) return snapshot;
      const scene = this as ProbeScene;
      const readHand = (hand: "left" | "right", rig?: ProbeHand): PosedHandProbe | null => {
        const pose = rig?.lastPose;
        if (!pose) return null;
        const handData = rig as ProbeHand & { lastPose: typeof pose; lastHoverLift?: number };
        const reconstructed = rigModule.reconstructHand3D(pose, 0);
        const rigidLift = Math.min(1, handData.lastHoverLift ?? 0) * 0.22;
        const thumbChain = (reconstructed.chains[1] ?? []).map(point => [point.x, point.y + rigidLift, point.z]);
        const fingerChains = Object.fromEntries(Object.entries(reconstructed.chains).map(([finger, chain]) => [
          finger,
          (chain ?? []).map(point => [point.x, point.y + rigidLift, point.z]),
        ]));
        const palmarDistalSupportWorldYByFinger: PosedHandProbe["palmarDistalSupportWorldYByFinger"] = {};
        const mesh = rig.rig?.skinnedMesh;
        if (mesh) {
          mesh.updateWorldMatrix(true, false);
          for (const finger of [1, 2, 3, 4, 5]) {
            const prefix = finger === 1 ? "thumb" : `${({ 2: "index", 3: "middle", 4: "ring", 5: "pinky" } as const)[finger]}-finger`;
            const distalBoneName = `${prefix}-phalanx-distal`;
            const boneIndex = mesh.skeleton.bones.findIndex(bone => bone.name === distalBoneName);
            const positions: number[] = [];
            if (boneIndex < 0) continue;
            const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
            for (let vertex = 0; vertex < position.count; vertex++) {
              let distalInfluence = 0;
              for (let component = 0; component < 4; component++) {
                if (skinIndex.getComponent(vertex, component) === boneIndex) {
                  distalInfluence += skinWeight.getComponent(vertex, component);
                }
              }
              if (distalInfluence < 0.2) continue;
              const point = createProbeVector(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
              mesh.applyBoneTransform(vertex, point);
              mesh.localToWorld(point);
              positions.push(point.y);
            }
            if (positions.length > 0) {
              positions.sort((a, b) => a - b);
              palmarDistalSupportWorldYByFinger[String(finger)] = {
                vertexCount: positions.length,
                minimumWorldY: positions[0]!,
                fifthPercentileWorldY: positions[Math.floor((positions.length - 1) * 0.05)]!,
                medianWorldY: positions[Math.floor((positions.length - 1) * 0.5)]!,
              };
            }
          }
        }
        const thumbBones: PosedHandProbe["thumbBones"] = {};
        for (const name of thumbBoneNames) {
          const bone = rig.rig?.bonesByName?.get(name)?.bone;
          if (!bone) continue;
          thumbBones[name] = {
            position: vector(bone.position),
            quaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
            scale: vector(bone.scale),
            worldMatrix: Array.from(bone.matrixWorld.elements),
            bindLengthIn: rig.rig?.bonesByName?.get(name)?.bindLengthIn ?? null,
          };
        }
        return {
          hand,
          poseTimeSeconds: pose.transportTimeSeconds,
          pose: JSON.parse(JSON.stringify(pose)) as unknown,
          appliedHoverLift: handData.lastHoverLift ?? null,
          reconstructedThumbChainWorldInches: thumbChain,
          reconstructedFingerChainsWorldInches: fingerChains,
          reconstructedHandFrame: {
            wristR: vector(reconstructed.wristR),
            wristU: vector(reconstructed.wristU),
            wristCenter: vector(reconstructed.wristCenter),
            armEnd: vector(reconstructed.armEnd),
            palmNormal: vector(reconstructed.palmNormal),
            wristWidthIn: reconstructed.wristWidthIn,
            chainsWorldInches: Object.fromEntries(Object.entries(reconstructed.chains).map(([finger, chain]) => [
              finger,
              (chain ?? []).map(point => [point.x, point.y + rigidLift, point.z]),
            ])),
          },
          palmarDistalSupportWorldYByFinger,
          allBones: Object.fromEntries([...(rig.rig?.bonesByName?.entries() ?? [])].map(([name, metadata]) => [
            name,
            {
              position: vector(metadata.bone.position),
              quaternion: [metadata.bone.quaternion.x, metadata.bone.quaternion.y, metadata.bone.quaternion.z, metadata.bone.quaternion.w],
              scale: vector(metadata.bone.scale),
              worldMatrix: Array.from(metadata.bone.matrixWorld.elements),
              bindPositionMeters: vector(metadata.bindPositionM),
              bindQuaternion: [metadata.bindQuaternion.x, metadata.bindQuaternion.y, metadata.bindQuaternion.z, metadata.bindQuaternion.w],
              localUpInWrist: vector(metadata.localUpInWrist),
              localLateralInWrist: vector(metadata.localLateralInWrist),
              bindLengthIn: metadata.bindLengthIn,
            },
          ])),
          thumbBones,
        };
      };
      probeWindow.__anatomicalPoseProbe = {
        viewTime: snapshot.viewTime,
        activePitches: [...(scene.lastActiveNotes ?? [])].sort((a, b) => a - b),
        hands: {
          left: readHand("left", scene.scene3D?.leftHand3D),
          right: readHand("right", scene.scene3D?.rightHand3D),
        },
      };
      if (singleCapture) probeWindow.__anatomicalPoseProbeCaptureRequested = false;
      return snapshot;
    };
  }, { singleCapture: options.singleCapture ?? false });
}

async function capturePosedThumbProbeOnce(page: Page, expectedViewTime: number) {
  await page.evaluate(() => {
    const probeWindow = window as unknown as {
      __anatomicalPoseProbe?: PosedSceneProbe | null;
      __anatomicalPoseProbeCaptureRequested?: boolean;
    };
    probeWindow.__anatomicalPoseProbe = null;
    probeWindow.__anatomicalPoseProbeCaptureRequested = true;
  });
  await expect.poll(() => page.evaluate(() => {
    const probeWindow = window as unknown as { __anatomicalPoseProbe?: PosedSceneProbe | null };
    return probeWindow.__anatomicalPoseProbe?.viewTime ?? null;
  }), { timeout: 10_000 }).toBeCloseTo(expectedViewTime, 2);
  return page.evaluate(() => {
    const probeWindow = window as unknown as { __anatomicalPoseProbe?: PosedSceneProbe | null };
    return probeWindow.__anatomicalPoseProbe ?? null;
  });
}

async function installActualKeyFootprintProbe(page: Page) {
  await page.evaluate(async () => {
    type ProbeVector = {
      x: number;
      y: number;
      z: number;
      set(x: number, y: number, z: number): ProbeVector;
      addScaledVector(value: { x: number; y: number; z: number }, scale: number): ProbeVector;
      applyMatrix4(matrix: { elements: ArrayLike<number> }): ProbeVector;
    };
    type ProbeAttribute = { count: number; getX(index: number): number; getY(index: number): number; getZ(index: number): number; getComponent(index: number, component: number): number };
    type ProbeSkinnedMesh = {
      geometry: { attributes: { position: ProbeAttribute; skinIndex: ProbeAttribute; skinWeight: ProbeAttribute } };
      skeleton: { bones: Array<{ name: string }> };
      applyBoneTransform(index: number, target: ProbeVector): ProbeVector;
      updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
      localToWorld(target: ProbeVector): ProbeVector;
    };
    type ProbeHandGroup = { rig?: { skinnedMesh?: ProbeSkinnedMesh } };
    type ProbeContactDiagnostics = { activeContactTargets?: Array<{ finger: number; pitch: number }> };
    type ProbeScene3D = {
      keyboard3D?: {
        sampleKeySurfaceYAt(pitch: number, worldX: number, worldZ: number): number | null;
        keysByPitch?: Map<number, { pivotGroup: { rotation: { x: number } } }>;
      };
      leftHand3D?: ProbeHandGroup;
      rightHand3D?: ProbeHandGroup;
      getHandModelDiagnostics?: () => { left: ProbeContactDiagnostics; right: ProbeContactDiagnostics };
    };
    type Snapshot = { viewTime: number };
    type InstrumentableScene = {
      scene3D?: ProbeScene3D;
      getGeometrySnapshot(): Snapshot;
    };

    const moduleUrl = new URL("/src/render/pianoScene.ts", location.origin).href;
    const module = await import(/* @vite-ignore */ moduleUrl) as {
      PianoScene: { prototype: { getGeometrySnapshot(this: InstrumentableScene): Snapshot } };
    };
    const prototype = module.PianoScene.prototype;
    const original = prototype.getGeometrySnapshot;
    const vector = (x = 0, y = 0, z = 0): ProbeVector => ({
      x,
      y,
      z,
      set(nextX, nextY, nextZ) { this.x = nextX; this.y = nextY; this.z = nextZ; return this; },
      addScaledVector(value, scale) { this.x += value.x * scale; this.y += value.y * scale; this.z += value.z * scale; return this; },
      applyMatrix4(matrix) {
        const e = matrix.elements;
        const reciprocalW = 1 / (e[3]! * this.x + e[7]! * this.y + e[11]! * this.z + e[15]!);
        const nextX = (e[0]! * this.x + e[4]! * this.y + e[8]! * this.z + e[12]!) * reciprocalW;
        const nextY = (e[1]! * this.x + e[5]! * this.y + e[9]! * this.z + e[13]!) * reciprocalW;
        const nextZ = (e[2]! * this.x + e[6]! * this.y + e[10]! * this.z + e[14]!) * reciprocalW;
        this.x = nextX;
        this.y = nextY;
        this.z = nextZ;
        return this;
      },
    });

    prototype.getGeometrySnapshot = function (this: InstrumentableScene): Snapshot {
      const snapshot = original.call(this);
      const scene3D = this.scene3D;
      const keyboard = scene3D?.keyboard3D;
      if (!scene3D || !keyboard?.sampleKeySurfaceYAt || !scene3D.getHandModelDiagnostics) return snapshot;

      window.__anatomicalActualKeyFootprintProbe = () => {
        const diagnostics = scene3D.getHandModelDiagnostics!();
        const readHand = (hand: "left" | "right", group?: ProbeHandGroup, targets?: ProbeContactDiagnostics) => {
          const mesh = group?.rig?.skinnedMesh;
          if (!mesh) return [] as ActualKeyFootprintProbe[];
          mesh.updateWorldMatrix(true, false);
          const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
          const rows: ActualKeyFootprintProbe[] = [];
          for (const target of targets?.activeContactTargets ?? []) {
            const prefix = target.finger === 1 ? "thumb" : `${({ 2: "index", 3: "middle", 4: "ring", 5: "pinky" } as const)[target.finger]}-finger`;
            const distalBoneIndex = mesh.skeleton.bones.findIndex(bone => bone.name === `${prefix}-phalanx-distal`);
            if (distalBoneIndex < 0) continue;
            let eligibleDistalVertices = 0;
            const gaps: number[] = [];
            for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex++) {
              let distalInfluence = 0;
              for (let component = 0; component < 4; component++) {
                if (skinIndex.getComponent(vertexIndex, component) === distalBoneIndex) {
                  distalInfluence += skinWeight.getComponent(vertexIndex, component);
                }
              }
              if (distalInfluence < 0.2) continue;
              eligibleDistalVertices++;
              const point = vector(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
              mesh.applyBoneTransform(vertexIndex, point);
              mesh.localToWorld(point);
              const keySurfaceY = keyboard.sampleKeySurfaceYAt(target.pitch, point.x, point.z);
              if (keySurfaceY !== null && Number.isFinite(keySurfaceY) && Number.isFinite(point.y)) {
                gaps.push((point.y - keySurfaceY) * 25.4);
              }
            }
            gaps.sort((a, b) => a - b);
            const percentile = (value: number) => gaps.length > 0
              ? gaps[Math.floor((gaps.length - 1) * value)]!
              : null;
            rows.push({
              hand,
              pitch: target.pitch,
              finger: target.finger,
              keyDepressionRadians: keyboard.keysByPitch?.get(target.pitch)?.pivotGroup.rotation.x ?? null,
              eligibleDistalVertices,
              verticesOnAssignedKeyTop: gaps.length,
              gapMillimeters: {
                minimum: percentile(0),
                p01: percentile(0.01),
                p05: percentile(0.05),
                median: percentile(0.5),
                maximum: percentile(1),
              },
              penetrationCounts: {
                belowSurface: gaps.filter(gap => gap < 0).length,
                beyond1mm: gaps.filter(gap => gap < -1).length,
                beyond3mm: gaps.filter(gap => gap < -3).length,
              },
            });
          }
          return rows;
        };
        return [
          ...readHand("left", scene3D.leftHand3D, diagnostics.left),
          ...readHand("right", scene3D.rightHand3D, diagnostics.right),
        ];
      };
      return snapshot;
    };
  });
}

async function installLiveNoteSourceProbe(page: Page) {
  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/render3d/pianoScene3d.ts", location.origin).href;
    const runtime = await import(/* @vite-ignore */ moduleUrl) as {
      PianoScene3D: { prototype: { update(this: InstrumentablePianoScene3D, timeSeconds: number, activeNotes?: number[]): void } };
    };
    const prototype = runtime.PianoScene3D.prototype;
    const originalUpdate = prototype.update;
    const records: LiveNoteSourceCapture[] = [];
    window.__anatomicalLiveNoteSourceProbe = records;
    prototype.update = function (this: InstrumentablePianoScene3D, timeSeconds: number, activeNotes?: number[]): void {
      originalUpdate.call(this, timeSeconds, activeNotes);
      const scene = this as unknown as {
        requestedHandModel?: HandModelId;
        currentTransportTime?: number;
        notes?: LiveSceneNoteRow[];
        performancePlan?: unknown;
        fallingNotes3D?: { getRenderedNoteTimings(): readonly LiveSceneNoteRow[] };
      };
      if (scene.requestedHandModel !== "anatomical-improved") return;
      const currentTransportTime = scene.currentTransportTime ?? timeSeconds;
      if (currentTransportTime < 0 || currentTransportTime > 10) return;
      const sceneNotes = scene.notes ?? [];
      const renderedNoteTimings = [...(scene.fallingNotes3D?.getRenderedNoteTimings() ?? [])];
      const noteSource = scene.performancePlan ? "renderedNoteTimings" : "scene.notes";
      const selected = scene.performancePlan ? renderedNoteTimings : sceneNotes;
      const nearTime = (note: LiveSceneNoteRow) =>
        note.startSeconds <= currentTransportTime + 0.5 && note.endSeconds >= currentTransportTime - 0.5;
      const diagnostics = this.getHandModelDiagnostics();
      records.push({
        requestedModel: scene.requestedHandModel,
        currentTransportTime,
        performancePlanPresent: Boolean(scene.performancePlan),
        noteSource,
        sceneNotes: sceneNotes.filter(nearTime).map(note => ({ ...note })),
        renderedNoteTimings: renderedNoteTimings.filter(nearTime).map(note => ({ ...note })),
        selectedNoteSource: selected.filter(nearTime).map(note => ({ ...note })),
        activeNoteSource: selected.filter(note => note.startSeconds <= currentTransportTime && note.endSeconds > currentTransportTime)
          .map(note => ({ ...note })),
        activeContactTargets: {
          left: diagnostics.left.activeContactTargets.map(target => ({ ...target })),
          right: diagnostics.right.activeContactTargets.map(target => ({ ...target })),
        },
      });
      if (records.length > 80) records.splice(0, records.length - 80);
    };
  });
}

function countVisibleSkinPixels(png: Buffer): number {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.subarray(0, 8).equals(signature), "canvas screenshots must be PNGs").toBe(true);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      expect(chunk[12], "interlaced PNG screenshots are unsupported by the pixel check").toBe(0);
    } else if (type === "IDAT") {
      compressed.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  expect(bitDepth).toBe(8);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  expect(channels, "screenshots must use truecolor PNG pixels").toBeGreaterThan(0);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const inputStart = y * (stride + 1);
    const filter = raw[inputStart]!;
    const rowStart = y * stride;
    const previousStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[inputStart + 1 + x]!;
      const left = x >= channels ? pixels[rowStart + x - channels]! : 0;
      const above = y > 0 ? pixels[previousStart + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previousStart + x - channels]! : 0;
      const predictor = filter === 1 ? left
        : filter === 2 ? above
          : filter === 3 ? Math.floor((left + above) / 2)
            : filter === 4 ? paeth(left, above, upperLeft)
              : 0;
      pixels[rowStart + x] = (value + predictor) & 0xff;
    }
    expect(filter).toBeLessThanOrEqual(4);
  }

  let count = 0;
  const firstLowerRow = Math.floor(height * 0.35);
  for (let y = firstLowerRow; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * stride + x * channels;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (red > 100 && green > 55 && green < 190 && blue > 35 && blue < 175 &&
          red > green * 1.12 && green > blue * 0.85 && red - blue > 20) count++;
    }
  }
  return count;
}

async function instrumentExportSceneReadiness(page: Page) {
  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/render3d/pianoScene3d.ts", location.origin).href;
    const runtime = await import(/* @vite-ignore */ moduleUrl) as {
      PianoScene3D: { prototype: InstrumentablePianoScene3D };
    };
    const prototype = runtime.PianoScene3D.prototype;
    const originalSetNotes = prototype.setNotes;
    const originalWait = prototype.waitForHandModelReady;
    const originalRender = prototype.renderFrame;
    const records: ExportReadinessRecord[] = [];
    const recordsByScene = new WeakMap<InstrumentablePianoScene3D, ExportReadinessRecord>();
    const notesByScene = new WeakMap<InstrumentablePianoScene3D, ExportReadinessRecord["projectedNotes"]>();
    window.__anatomicalExportReadiness = records;

    prototype.setNotes = function (
      this: InstrumentablePianoScene3D,
      notes: ExportReadinessRecord["projectedNotes"],
    ): void {
      notesByScene.set(this, notes.map(note => ({ ...note })));
      originalSetNotes.call(this, notes);
    };
    prototype.waitForHandModelReady = async function (this: InstrumentablePianoScene3D): Promise<void> {
      await originalWait.call(this);
      const record: ExportReadinessRecord = {
        projectedNotes: notesByScene.get(this) ?? [],
        ready: this.getHandModelDiagnostics(),
        firstRenderedFrame: null,
        contactTargetFrames: [],
      };
      records.push(record);
      recordsByScene.set(this, record);
    };
    prototype.renderFrame = function (this: InstrumentablePianoScene3D): void {
      originalRender.call(this);
      const record = recordsByScene.get(this);
      if (record) {
        const diagnostics = this.getHandModelDiagnostics();
        if (!record.firstRenderedFrame) record.firstRenderedFrame = diagnostics;
        if (diagnostics.left.activeContactTargets.length > 0 || diagnostics.right.activeContactTargets.length > 0) {
          record.contactTargetFrames.push(diagnostics);
        }
      }
    };
  });
}

test("improved hand selection persists and leaves the playing project and audio output intact", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = await loadTwoHandDemoSong(page);
  await expect(studioCanvas(page, "3d")).toBeVisible();
  await expect(page.getByRole("group", { name: "3D camera presets", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  const selector = preferences.locator("#settings-hand-model");
  await expect(selector.locator("option")).toHaveCount(4);
  expect(await selector.locator("option").evaluateAll(options => options.map(option => ({
    value: (option as HTMLOptionElement).value,
    label: option.textContent?.trim(),
  })))).toEqual([
    { value: "anatomical", label: "Anatomical (Realistic)" },
    { value: "anatomical-improved", label: "Anatomical (improved)" },
    { value: "testing", label: "Testing (WebXR motion + realistic skin)" },
    { value: "webxr", label: "WebXR Standard" },
  ]);
  await preferences.getByRole("button", { name: "Done", exact: true }).click();

  const play = page.locator("#player-play-button");
  await play.click();
  await expect(play).toContainText("Pause");
  const seek = page.getByRole("slider", { name: "Seek position", exact: true });
  const timeBefore = Number(await seek.inputValue());
  await expect.poll(() => seek.inputValue().then(Number), { timeout: 15_000, intervals: [250] }).toBeGreaterThan(timeBefore + 0.4);
  const planBefore = initial.result.performancePlan?.planId ?? null;
  const outputBefore = (await committedStudioSettings(page)).soundOutput;
  expect(outputBefore).toBe("synth");

  await selectHandModel(page, "anatomical-improved");

  await expect(play).toContainText("Pause");
  await expect.poll(() => seek.inputValue().then(Number), { timeout: 15_000, intervals: [250] }).toBeGreaterThan(timeBefore + 0.8);
  await play.click();
  await expect(play).toContainText("Play");
  for (const model of ["webxr", "anatomical", "webxr", "anatomical-improved"] as const) {
    await selectHandModel(page, model);
  }

  const afterSwitches = await browserSnapshot(page);
  expect(afterSwitches).not.toBeNull();
  expect(afterSwitches).toMatchObject({
    projectId: initial.result.projectId,
    revision: initial.result.revision,
    performancePlanId: planBefore,
    pending: false,
  });
  expect((await committedStudioSettings(page)).soundOutput).toBe(outputBefore);

  await page.reload();
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true", { timeout: 90_000 });
  await expect.poll(async () => (await committedStudioSettings(page)).handModel).toBe("anatomical-improved");
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true }).locator("#settings-hand-model"))
    .toHaveValue("anatomical-improved");
  await page.getByRole("dialog", { name: "Preferences", exact: true }).getByRole("button", { name: "Done", exact: true }).click();

  await testInfo.attach("anatomical-improved-settings-regression", {
    contentType: "application/json",
    body: JSON.stringify({
      projectId: initial.result.projectId,
      revision: initial.result.revision,
      performancePlanId: planBefore,
      finalSettings: await committedStudioSettings(page),
      trackFixture: "tracked-demo-song.mid (both hands)",
      playbackAdvancedWhileSwitching: true,
      persistedAfterReload: "anatomical-improved",
    }, null, 2),
  });
});

test("compare loaded hand models across cameras, animation, seek, viewport sizes, and frame costs", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  const handAssetResponses: Array<{ url: string; status: number }> = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/models/hands/")) handAssetResponses.push({ url: response.url(), status: response.status() });
  });

  const loaded = await loadTwoHandDemoSong(page);
  const canvas = studioCanvas(page, "3d");
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("group", { name: "3D camera presets", exact: true })).toBeVisible();
  expect(loaded.result.motionPlan?.poses.length ?? 0).toBeGreaterThan(0);
  const seek = page.getByRole("slider", { name: "Seek position", exact: true });
  const seekMaximum = Number(await seek.getAttribute("max"));
  const staticTime = Math.min(0.75, Math.max(0, seekMaximum * 0.2));
  await seekToTime(page, staticTime);

  const measurements: Array<Record<string, unknown>> = [];
  for (const model of models) {
    await selectHandModel(page, model);
    await expectLoadedModel(page, model);
    await seekToTime(page, staticTime);
    const initialDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
    expect(initialDiagnostics).not.toBeNull();
    expect(initialDiagnostics!.renderer.drawCalls).toBeGreaterThan(0);
    expect(initialDiagnostics!.renderer.triangles).toBeGreaterThan(0);

    for (const camera of cameras) {
      await setCamera(page, camera);
      await expectLoadedModel(page, model);
      await saveScreenshot(page, testInfo, `${model}-${camera}-desktop.png`);
      const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
      expect(diagnostics?.left.requestedModel).toBe(model);
      expect(diagnostics?.right.requestedModel).toBe(model);
      expect(diagnostics?.left.triangles).toBeGreaterThan(0);
      expect(diagnostics?.right.triangles).toBeGreaterThan(0);
      measurements.push({
        model,
        camera,
        viewport: "desktop 1440x900",
        left: diagnostics?.left,
        right: diagnostics?.right,
        renderer: diagnostics?.renderer,
      });
    }

    // Side Arch is the close camera. The larger viewport keeps this view at
    // native high resolution while preserving the scene's production camera.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await setCamera(page, "side_arch");
    await expectLoadedModel(page, model);
    await saveScreenshot(page, testInfo, `${model}-side_arch-close-1600x1000.png`);
    const desktopSample = await sampleAnimatedRender(page, 120);
    await seekToTime(page, staticTime);
    const desktopDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
    measurements.push({
      model,
      viewport: "desktop 1600x1000",
      workload: "animated playback after 500ms warm-up at side_arch camera",
      targetFps: 60,
      sample: desktopSample,
      rendererWindow: desktopDiagnostics?.renderer,
      rendererFramesPerSecond: desktopDiagnostics && desktopDiagnostics.renderer.renderWindowMs > 0
        ? desktopDiagnostics.renderer.renderedFramesWindow * 1000 / desktopDiagnostics.renderer.renderWindowMs
        : null,
      renderer: desktopDiagnostics?.renderer,
      left: desktopDiagnostics?.left,
      right: desktopDiagnostics?.right,
      meanHandUpdateCpuMs: desktopDiagnostics?.renderer.handUpdateMeanMs ?? null,
      lastHandUpdateCpuMs: desktopDiagnostics?.renderer.handUpdateLastMs ?? null,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await setCamera(page, "pov");
    await expectLoadedModel(page, model);
    await saveScreenshot(page, testInfo, `${model}-pov-mobile-390x844.png`);
    const mobileSample = await sampleAnimatedRender(page, 90);
    await seekToTime(page, staticTime);
    const mobileDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
    measurements.push({
      model,
      viewport: "emulated mobile 390x844",
      physicalDevice: false,
      workload: "animated playback after 500ms warm-up at pov camera",
      targetFps: 30,
      sample: mobileSample,
      rendererWindow: mobileDiagnostics?.renderer,
      rendererFramesPerSecond: mobileDiagnostics && mobileDiagnostics.renderer.renderWindowMs > 0
        ? mobileDiagnostics.renderer.renderedFramesWindow * 1000 / mobileDiagnostics.renderer.renderWindowMs
        : null,
      renderer: mobileDiagnostics?.renderer,
      left: mobileDiagnostics?.left,
      right: mobileDiagnostics?.right,
      meanHandUpdateCpuMs: mobileDiagnostics?.renderer.handUpdateMeanMs ?? null,
      lastHandUpdateCpuMs: mobileDiagnostics?.renderer.handUpdateLastMs ?? null,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await setCamera(page, "pov");
    await seekToTime(page, staticTime);
    await page.locator("#player-play-button").click();
    const currentTime = Number(await seek.inputValue());
    await expect.poll(() => seek.inputValue().then(Number), { timeout: 15_000, intervals: [250] })
      .toBeGreaterThan(currentTime + 0.4);
    await saveScreenshot(page, testInfo, `${model}-animation-pov.png`);
    await page.locator("#player-play-button").click();
    await expect(page.locator("#player-play-button")).toContainText("Play");
    const seekTarget = Math.min(Math.max(staticTime + 0.5, 1.25), Math.max(staticTime, seekMaximum - 0.1));
    await seekToTime(page, seekTarget);
    await saveScreenshot(page, testInfo, `${model}-seek-pov.png`);
  }

  expect(handAssetResponses.some(response => response.url.endsWith("/models/hands/improved/manifest.json")),
    "improved model selection should resolve its manifest from the public asset base").toBe(true);
  expect(handAssetResponses.filter(response => response.status >= 400), "hand model and texture requests should succeed").toEqual([]);
  for (const hand of ["left", "right"] as const) {
    expect(handAssetResponses.some(response => response.url.includes(`/models/hands/improved/${hand}-lod`)),
      `${hand} improved GLB should be requested`).toBe(true);
  }
  expect(handAssetResponses.some(response => response.url.includes("/models/hands/improved/textures/")),
    "shared improved textures should be requested from the public asset base").toBe(true);
  expect(pageErrors).toEqual([]);
  const finalSnapshot = await browserSnapshot(page);
  await testInfo.attach("anatomical-improved-browser-measurements", {
    contentType: "application/json",
    body: JSON.stringify({
      source: "real Studio Player with tracked-demo-song MIDI (both hands), Worker motion, and production 3D scene",
      viewportCaveat: "390x844 is browser viewport emulation, not a physical mobile device",
      frameGoals: { desktopFps: 60, mobileFps: 30, acceptanceGuarantee: false },
      performanceMethod: "Renderer frame rate is the runtime render count divided by its measurement window; rAF p50/p95 are reported separately as browser callback intervals. Hand-update timings are CPU timings, not GPU timings.",
      memoryNote: "renderer geometries/textures are resource counts; cachedAssetBytes includes retained GLB bytes and a decoded base-level texture estimate, not measured GPU memory",
      browser: await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="piano-canvas-3d"]');
        const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null;
        const debug = gl?.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
        return {
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          headless: navigator.webdriver,
          webgl: gl && debug ? {
            vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
            renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
          } : gl ? { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) } : null,
        };
      }),
      browserLaunch: {
        configuredChannel: process.env.PIANOMOTION_BROWSER_CHANNEL || "chrome",
        headless: true,
        customFlags: [],
      },
      measurements,
      handAssetResponses,
      finalProject: finalSnapshot ? { projectId: finalSnapshot.projectId, revision: finalSnapshot.revision } : null,
      pageErrors,
    }, null, 2),
  });
});

test("post-fix improved model is visible in posed views and reports no WebGL errors", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/models/hands/")) assetResponses.push({ url: response.url(), status: response.status() });
  });

  const loaded = await loadTwoHandDemoSong(page);
  await installPosedThumbProbe(page);
  await selectAndWaitForImprovedHand(page);
  await installLiveNoteSourceProbe(page);
  const seek = page.getByRole("slider", { name: "Seek position", exact: true });
  const maximum = Number(await seek.getAttribute("max"));
  const poseTime = Math.min(0.75, Math.max(0, maximum * 0.2));
  await seekToTime(page, poseTime);
  await expect.poll(() => page.evaluate(() =>
    window.__anatomicalLiveNoteSourceProbe?.some(record => Math.abs(record.currentTransportTime - 0.75) < 0.03) ?? false,
  ), { timeout: 10_000 }).toBe(true);
  const performanceEvents = loaded.result.performancePlan?.events ?? [];
  const activeMidiNotes = new Map<string, number>();
  const pitchByNoteId = new Map<string, number>();
  const pressByNoteId = new Map<string, { pitch: number; timeSeconds: number }>();
  const releaseByNoteId = new Map<string, number>();
  for (const event of performanceEvents) {
    if (event.type === "press" && event.noteId && event.pitch != null) {
      pitchByNoteId.set(event.noteId, event.pitch);
      pressByNoteId.set(event.noteId, { pitch: event.pitch, timeSeconds: event.timeSeconds });
    }
    if (event.type === "release" && event.noteId) releaseByNoteId.set(event.noteId, event.timeSeconds);
    if (event.timeSeconds <= poseTime) {
      if (event.type === "press" && event.noteId && event.pitch != null) activeMidiNotes.set(event.noteId, event.pitch);
      else if (event.type === "release" && event.noteId) activeMidiNotes.delete(event.noteId);
    }
  }
  const activeMidiPitches = [...new Set(activeMidiNotes.values())].sort((a, b) => a - b);
  const assignmentByNoteId = new Map((loaded.result.fingeringPlan?.assignments ?? []).map(assignment => [assignment.noteId, assignment]));
  const nearbyPerformanceEvents = performanceEvents
    .filter(event => Math.abs(event.timeSeconds - poseTime) <= 0.5)
    .map(event => ({ ...event, pitch: "pitch" in event ? event.pitch : ("noteId" in event && event.noteId ? pitchByNoteId.get(event.noteId) : undefined) }));

  const screenshots: Array<{
    camera: CameraId;
    path: string;
    diagnostics: HandModelDiagnostics | null;
    visibleSkinPixelCount: number;
    posedProbe: PosedSceneProbe | null;
  }> = [];
  for (const camera of cameras) {
    await setCamera(page, camera);
    await expectLoadedModel(page, "anatomical-improved");
    await expect.poll(() => page.evaluate(() => window.__anatomicalPoseProbe?.viewTime ?? null), { timeout: 10_000 })
      .toBeCloseTo(poseTime, 1);
    const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
    expect(diagnostics?.left.triangles).toBeGreaterThan(0);
    expect(diagnostics?.right.triangles).toBeGreaterThan(0);
    expect(diagnostics?.renderer.drawCalls).toBeGreaterThan(0);
    expect(diagnostics?.renderer.triangles).toBeGreaterThan(0);
    const name = `anatomical-improved-post-fix-${camera}.png`;
    const path = testInfo.outputPath(name);
    const png = await studioCanvas(page, "3d").screenshot({ path });
    const visibleSkinPixelCount = countVisibleSkinPixels(png);
    expect(visibleSkinPixelCount, `${camera} view must contain a visible hand-skin area, not only renderer counters`).toBeGreaterThan(5_000);
    await testInfo.attach(name.replace(/\.png$/i, ""), { path, contentType: "image/png" });
    const posedProbe = await page.evaluate(() => window.__anatomicalPoseProbe ?? null);
    expect(posedProbe?.hands.left?.pose, `${camera} left hand must have an applied motion pose`).toBeTruthy();
    expect(posedProbe?.hands.right?.pose, `${camera} right hand must have an applied motion pose`).toBeTruthy();
    expect(posedProbe?.hands.left?.thumbBones["thumb-metacarpal"], `${camera} left thumb chain must expose bone transforms`).toBeTruthy();
    expect(posedProbe?.hands.right?.thumbBones["thumb-metacarpal"], `${camera} right thumb chain must expose bone transforms`).toBeTruthy();
    screenshots.push({ camera, path, diagnostics, visibleSkinPixelCount, posedProbe });
  }

  const pausedNoteSourceCapture = await page.evaluate(() => {
    const records = window.__anatomicalLiveNoteSourceProbe ?? [];
    return [...records].reverse().find(record => Math.abs(record.currentTransportTime - 0.75) < 0.03) ?? null;
  });
  await page.locator("#player-speed-select").selectOption("0.25");
  await seekToTime(page, 0.6);
  await page.locator("#player-play-button").click();
  await expect.poll(() => page.evaluate(() =>
    window.__anatomicalLiveNoteSourceProbe?.some(record => record.currentTransportTime >= 0.65 && record.currentTransportTime <= 1.25) ?? false,
  ), { timeout: 10_000, intervals: [100, 200] }).toBe(true);
  const playbackNoteSourceCapture = await page.evaluate(() => {
    const records = window.__anatomicalLiveNoteSourceProbe ?? [];
    return [...records].reverse().find(record => record.currentTransportTime >= 0.65 && record.currentTransportTime <= 1.25) ?? null;
  });
  await page.locator("#player-play-button").click();

  const referencePose = screenshots[0]?.posedProbe;
  const activeMidiNoteDetails = [...activeMidiNotes.entries()].map(([noteId, pitch]) => {
    const assignment = assignmentByNoteId.get(noteId);
    const fingerChain = assignment?.finger == null
      ? undefined
      : referencePose?.hands[assignment.hand]?.reconstructedFingerChainsWorldInches[String(assignment.finger)];
    const distalPadSupport = assignment?.finger == null
      ? undefined
      : referencePose?.hands[assignment.hand]?.palmarDistalSupportWorldYByFinger[String(assignment.finger)];
    const pitchClass = pitch % 12;
    const isBlackKey = [1, 3, 6, 8, 10].includes(pitchClass);
    return {
      noteId,
      pitch,
      hand: assignment?.hand ?? null,
      finger: assignment?.finger ?? null,
      pressTimeSeconds: pressByNoteId.get(noteId)?.timeSeconds ?? null,
      releaseTimeSeconds: releaseByNoteId.get(noteId) ?? null,
      key: { color: isBlackKey ? "black" : "white", topYWorldInches: isBlackKey ? 0.46 : 0 },
      assignedFingerTipWorldInches: fingerChain?.at(-1) ?? null,
      actualPalmarDistalPadSupport: distalPadSupport ? {
        ...distalPadSupport,
        keyClearanceWorldInches: distalPadSupport.minimumWorldY - (isBlackKey ? 0.46 : 0),
      } : null,
    };
  });

  const expectedContactsAt = (timeSeconds: number) => {
    const releaseTimes = new Map<string, number>();
    for (const event of performanceEvents) {
      if (event.type === "release" && event.noteId) releaseTimes.set(event.noteId, event.timeSeconds);
    }
    return performanceEvents.flatMap(event => {
      if (event.type !== "press" || !event.noteId || event.pitch == null || event.timeSeconds > timeSeconds ||
          (releaseTimes.get(event.noteId) ?? Number.NEGATIVE_INFINITY) <= timeSeconds) return [];
      const assignment = assignmentByNoteId.get(event.noteId);
      return assignment && assignment.finger !== null
        ? [{ noteId: event.noteId, pitch: event.pitch, hand: assignment.hand, finger: assignment.finger }]
        : [];
    });
  };
  const expectedPausedContacts = expectedContactsAt(poseTime);
  const expectedPlaybackContacts = playbackNoteSourceCapture
    ? expectedContactsAt(playbackNoteSourceCapture.currentTransportTime)
    : [];

  const report = {
    model: "anatomical-improved",
    poseTimeSeconds: poseTime,
    activeMidiPitchesAtPoseTime: activeMidiPitches,
    activeMidiNoteDetails,
    sourcePlanAssignmentsForActiveNotes: activeMidiNoteDetails.map(note => ({
      noteId: note.noteId,
      pitch: note.pitch,
      hand: note.hand,
      finger: note.finger,
    })),
    pausedNoteSourceCapture,
    expectedPausedContacts,
    playbackNoteSourceCapture,
    expectedPlaybackContacts,
    performanceEventsWithinHalfSecond: nearbyPerformanceEvents,
    viewport: { width: 1440, height: 900 },
    screenshotFiles: screenshots.map(({ camera, path, visibleSkinPixelCount }) => ({ camera, path, visibleSkinPixelCount })),
    diagnosticsByCamera: screenshots.map(({ camera, diagnostics, posedProbe }) => ({ camera, diagnostics, posedProbe })),
    assetResponses,
    consoleMessages,
    pageErrors,
  };
  await testInfo.attach("post-fix-improved-visibility-diagnostics", {
    contentType: "application/json",
    body: JSON.stringify(report, null, 2),
  });

  expect(assetResponses.filter(response => response.status >= 400)).toEqual([]);
  expect(pageErrors, "browser runtime must not report uncaught errors").toEqual([]);
  expect(consoleMessages.filter(message => /shader|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text)),
    "the renderer must not report shader, vertex attribute, or WebGL errors").toEqual([]);
  expect(screenshots).toHaveLength(cameras.length);
  expect(pausedNoteSourceCapture, "paused seek must expose the live scene's renderer note source around t=.75").not.toBeNull();
  for (const expected of expectedPausedContacts) {
    expect(pausedNoteSourceCapture!.activeNoteSource.some(note => note.noteId === expected.noteId &&
      note.pitch === expected.pitch && note.hand === expected.hand && note.finger === expected.finger),
    `paused renderer note source must retain assignment for ${expected.noteId}`).toBe(true);
    expect(pausedNoteSourceCapture!.activeContactTargets[expected.hand]).toContainEqual({
      pitch: expected.pitch,
      finger: expected.finger,
    });
  }
  expect(playbackNoteSourceCapture, "live playback must expose a renderer note source while notes are active").not.toBeNull();
  for (const expected of expectedPlaybackContacts) {
    expect(playbackNoteSourceCapture!.activeNoteSource.some(note => note.noteId === expected.noteId &&
      note.pitch === expected.pitch && note.hand === expected.hand && note.finger === expected.finger),
    `playing renderer note source must retain assignment for ${expected.noteId}`).toBe(true);
    expect(playbackNoteSourceCapture!.activeContactTargets[expected.hand]).toContainEqual({
      pitch: expected.pitch,
      finger: expected.finger,
    });
  }
});

test("short 3D video export renders, saves, and decodes with the improved model selected", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await installOpfsSavePicker(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await loadShortTwoHandSong(page);
  await selectAndWaitForImprovedHand(page);
  const selectedDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
  expect(selectedDiagnostics?.left.loadedModel).toBe("anatomical-improved");
  expect(selectedDiagnostics?.right.loadedModel).toBe("anatomical-improved");
  await openVideoExportModal(page, "720p");
  await page.locator("#export-audio-checkbox").uncheck();
  await expect(page.locator("#export-format-capability")).not.toContainText("Checking encoder support", { timeout: 90_000 });
  await expect(page.locator("#start-export-btn")).toBeEnabled();

  await instrumentExportSceneReadiness(page);
  await page.locator("#start-export-btn").click();
  await expect.poll(() => page.locator("#export-status-text").innerText(), {
    timeout: 180_000,
    intervals: [500, 1000, 2000],
  }).toMatch(/Export completed successfully|Export failed/i);
  const status = await page.locator("#export-status-text").innerText();
  expect(status).toBe("Export completed successfully.");
  await expect(page.locator("#saved-video-file").or(page.locator("#download-video-btn"))).toBeVisible();
  const { name, bytes } = await readOpfsOutput(page, 0);
  const outputPath = testInfo.outputPath(name);
  await writeFile(outputPath, bytes);
  const mimeType = name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
  await testInfo.attach("anatomical-improved-short-video-export", { path: outputPath, contentType: mimeType });

  const decoded = await page.evaluate(async ({ base64, mimeType: contentType }) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(`Browser video decode failed: ${video.error?.message ?? "unknown"}`)), { once: true });
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Video decode canvas has no 2D context.");
    const readPixels = () => {
      context.drawImage(video, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const firstFrame = readPixels();
    const laterFrameTime = 0.75;
    video.currentTime = Math.min(laterFrameTime, Math.max(0, video.duration - 0.1));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(`Video seek failed: ${video.error?.message ?? "unknown"}`)), { once: true });
    });
    const laterFrame = readPixels();
    let changedPixels = 0;
    for (let pixel = 0; pixel < firstFrame.length; pixel += 4) {
      if (Math.abs(firstFrame[pixel]! - laterFrame[pixel]!) +
          Math.abs(firstFrame[pixel + 1]! - laterFrame[pixel + 1]!) +
          Math.abs(firstFrame[pixel + 2]! - laterFrame[pixel + 2]!) > 36) changedPixels++;
    }
    return {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      durationSeconds: video.duration,
      firstFrameTimeSeconds: 0,
      laterFrameTimeSeconds: video.currentTime,
      changedPixels,
      firstFrameHasSignal: firstFrame.some((value, index) => index % 4 !== 3 && value > 24 && value < 230),
    };
  }, { base64: bytes.toString("base64"), mimeType });
  expect(decoded.videoWidth).toBe(1280);
  expect(decoded.videoHeight).toBe(720);
  expect(decoded.durationSeconds).toBeGreaterThanOrEqual(1.5);
  expect(decoded.changedPixels).toBeGreaterThan(0);
  expect(decoded.firstFrameHasSignal).toBe(true);
  const exportReadiness = await page.evaluate(() => window.__anatomicalExportReadiness ?? []);
  expect(exportReadiness, "the actual isolated export scene must await its selected hand model").toHaveLength(1);
  const exportScene = exportReadiness[0]!;
  for (const [phase, diagnostics] of [
    ["ready before export render", exportScene.ready],
    ["first export render", exportScene.firstRenderedFrame],
  ] as const) {
    expect(diagnostics, `${phase} diagnostics must be captured`).not.toBeNull();
    for (const hand of [diagnostics!.left, diagnostics!.right]) {
      expect(hand.requestedModel, `${phase} requested model`).toBe("anatomical-improved");
      expect(hand.loadedModel, `${phase} loaded model`).toBe("anatomical-improved");
      expect(hand.state, `${phase} load state`).toBe("ready");
      expect(hand.error, `${phase} load error`).toBeNull();
      expect(hand.requestedLod, `${phase} requested fixed export LOD`).toBe(0);
      expect(hand.loadedLod, `${phase} loaded fixed export LOD`).toBe(0);
    }
  }
  expect(exportScene.firstRenderedFrame!.renderer.renderedFramesTotal)
    .toBeGreaterThan(exportScene.ready.renderer.renderedFramesTotal);
  const performanceEvents = await page.evaluate(() => {
    const snapshot = window.__playerSnapshot;
    return snapshot?.result.performancePlan?.events ?? [];
  });
  const projectedNotesById = new Map(exportScene.projectedNotes.map(note => [note.noteId, note]));
  const expectedContacts = performanceEvents
      .filter((event): event is Extract<typeof event, { type: "press" }> => event.type === "press" && !!event.noteId && typeof event.pitch === "number")
      .map(event => {
        const note = projectedNotesById.get(event.noteId);
        return note && note.finger !== null
          ? { hand: note.hand, finger: note.finger, pitch: event.pitch }
          : null;
      })
      .filter((contact): contact is { hand: "left" | "right"; finger: number; pitch: number } => contact !== null);
  expect(exportScene.projectedNotes.length).toBeGreaterThan(0);
  expect(expectedContacts.some(contact => contact.hand === "left")).toBe(true);
  expect(expectedContacts.some(contact => contact.hand === "right")).toBe(true);
  expect(exportScene.contactTargetFrames.length, "actual export updates must receive pressed-note contact targets").toBeGreaterThan(0);
  for (const hand of ["left", "right"] as const) {
    const expectedForHand = expectedContacts.filter(contact => contact.hand === hand);
    expect(exportScene.contactTargetFrames.some(frame =>
      frame[hand].activeContactTargets.some(target => expectedForHand.some(expected =>
        expected.pitch === target.pitch && expected.finger === target.finger))),
    `export ${hand} contact targets must match the frozen fingering assignment`).toBe(true);
  }
  await testInfo.attach("anatomical-improved-export-decode", {
    contentType: "application/json",
    body: JSON.stringify({
      name,
      sizeBytes: bytes.byteLength,
      mimeType,
      decoded,
      liveSelectedDiagnostics: selectedDiagnostics,
      expectedContacts,
      exportSceneReadiness: exportReadiness,
    }, null, 2),
  });
});

test("compare public and topological candidate improved LOD1 in identical active-note views", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const viewport = { width: 1440, height: 900 };
  const poseTime = 0.75;
  const candidateFiles = {
    left: fileURLToPath(new URL("../../scratch/improved-qa/frozen-topological-lod1/left-lod1.glb", import.meta.url)),
    right: fileURLToPath(new URL("../../scratch/improved-qa/frozen-topological-lod1/right-lod1.glb", import.meta.url)),
  };
  const sourceFiles = [
    "apps/client/src/render3d/handRigBuilder.ts",
    "apps/client/src/render3d/pianoScene3d.ts",
    "apps/client/src/render/pianoScene.ts",
    "apps/client/src/render3d/improvedHandRuntime.ts",
  ];
  const versionContext = {
    qaViteHmr: false,
    sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async relativePath => [
      relativePath,
      createHash("sha256").update(await readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)))).digest("hex"),
    ]))),
    topologicalCandidateSha256: Object.fromEntries(await Promise.all(Object.entries(candidateFiles).map(async ([hand, path]) => [
      hand,
      createHash("sha256").update(await readFile(path)).digest("hex"),
    ]))),
  };
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const glbRequests: string[] = [];
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(viewport);
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    if (/\/models\/hands\/improved\/(left|right)-lod1\.glb/.test(request.url())) glbRequests.push(request.url());
  });

  const captureBothCameras = async (variant: "public" | "topological-candidate") => {
    const loaded = await loadTwoHandDemoSong(page);
    await selectAndWaitForImprovedHand(page);
    await seekToTime(page, poseTime);
    const initialDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics;
    expect(initialDiagnostics?.left.loadedLod, `${variant} left hand must use the same LOD`).toBe(1);
    expect(initialDiagnostics?.right.loadedLod, `${variant} right hand must use the same LOD`).toBe(1);
    const activeNotes = new Map<string, number>();
    const pitchByNoteId = new Map<string, number>();
    for (const event of loaded.result.performancePlan?.events ?? []) {
      if (event.type === "press" && event.noteId && event.pitch != null) pitchByNoteId.set(event.noteId, event.pitch);
      if (event.timeSeconds > poseTime) continue;
      if (event.type === "press" && event.noteId && event.pitch != null) activeNotes.set(event.noteId, event.pitch);
      else if (event.type === "release" && event.noteId) activeNotes.delete(event.noteId);
    }
    const assignments = new Map((loaded.result.fingeringPlan?.assignments ?? []).map(assignment => [assignment.noteId, assignment]));
    const notesAtPose = [...activeNotes.entries()].map(([noteId, pitch]) => ({
      noteId,
      pitch,
      assignment: assignments.get(noteId) ?? null,
      keyColor: [1, 3, 6, 8, 10].includes(pitch % 12) ? "black" : "white",
      pressTimeSeconds: (loaded.result.performancePlan?.events ?? []).find(event => event.type === "press" && event.noteId === noteId)?.timeSeconds ?? null,
      releaseTimeSeconds: (loaded.result.performancePlan?.events ?? []).find(event => event.type === "release" && event.noteId === noteId)?.timeSeconds ?? null,
    }));
    expect(notesAtPose.length, "the A/B must compare a real active MIDI pose").toBeGreaterThan(0);

    const cameras: Array<{ camera: CameraId; imagePath: string; visibleSkinPixelCount: number; diagnostics: HandModelDiagnostics | null }> = [];
    for (const camera of ["pov", "side_arch"] as const) {
      await setCamera(page, camera);
      await expectLoadedModel(page, "anatomical-improved");
      const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
      expect(diagnostics?.left.loadedLod).toBe(1);
      expect(diagnostics?.right.loadedLod).toBe(1);
      const imagePath = testInfo.outputPath(`anatomical-improved-${variant}-${camera}.png`);
      const screenshot = await studioCanvas(page, "3d").screenshot({ path: imagePath });
      const visibleSkinPixelCount = countVisibleSkinPixels(screenshot);
      expect(visibleSkinPixelCount, `${variant} ${camera} must render visible hand skin`).toBeGreaterThan(5_000);
      await testInfo.attach(`anatomical-improved-${variant}-${camera}`, { path: imagePath, contentType: "image/png" });
      cameras.push({ camera, imagePath, visibleSkinPixelCount, diagnostics });
    }
    return { notesAtPose, pitchByNoteId: Object.fromEntries(pitchByNoteId), cameras };
  };

  const publicCapture = await captureBothCameras("public");
  await page.route("**/models/hands/improved/left-lod1.glb", route => route.fulfill({
    status: 200,
    contentType: "model/gltf-binary",
    path: candidateFiles.left,
  }));
  await page.route("**/models/hands/improved/right-lod1.glb", route => route.fulfill({
    status: 200,
    contentType: "model/gltf-binary",
    path: candidateFiles.right,
  }));
  await page.reload();
  const candidateCapture = await captureBothCameras("topological-candidate");
  expect(glbRequests.some(url => url.endsWith("/left-lod1.glb"))).toBe(true);
  expect(glbRequests.some(url => url.endsWith("/right-lod1.glb"))).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleMessages.filter(message => /shader|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text))).toEqual([]);
  await testInfo.attach("anatomical-improved-topological-lod1-ab-report", {
    contentType: "application/json",
    body: JSON.stringify({
      viewport,
      poseTimeSeconds: poseTime,
      notesAtPose: publicCapture.notesAtPose,
      versionContext,
      publicCapture,
      candidateCapture,
      glbRequests,
      consoleMessages,
      pageErrors,
      comparisonScope: "Same 1440x900 viewport, .75s MIDI pose, camera, and public materials; only the two LOD1 GLBs were route-substituted with the frozen topological weight candidate.",
    }, null, 2),
  });
});

test("compare public and coherent carpal-root candidate with its own manifest and assets", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  type CandidateManifest = {
    modelId: string;
    hands: Record<"left" | "right", { lods: Array<{ level: number; url: string; triangles: number; textureSet?: string }> }>;
    textures: Record<string, Record<string, unknown>>;
    extras?: Record<string, unknown>;
  };
  const viewport = { width: 1440, height: 900 };
  const poseTime = 0.75;
  const candidateSourceDirectory = process.env.PIANOMOTION_CARPAL_CANDIDATE_DIR
    ? resolve(process.env.PIANOMOTION_CARPAL_CANDIDATE_DIR)
    : fileURLToPath(new URL("../../scratch/improved-assets/carpal-roots-reference-candidate-output/", import.meta.url));
  const frozenCandidateDirectory = testInfo.outputPath("frozen-carpal-roots-reference-candidate-package");
  const publicDirectory = fileURLToPath(new URL("../../apps/client/public/models/hands/improved/", import.meta.url));
  const readManifest = async (directory: string) => JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CandidateManifest;
  const assetPathsForManifest = (manifest: CandidateManifest) => [...new Set([
    "manifest.json",
    ...["left", "right"].flatMap(hand => manifest.hands[hand as "left" | "right"].lods.map(lod => lod.url)),
    ...Object.values(manifest.textures).flatMap(textureSet => Object.values(textureSet)
      .filter((value): value is string => typeof value === "string" && value.startsWith("textures/"))),
  ])].sort();
  const sha256Files = async (directory: string, paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async relativePath => [
    relativePath,
    createHash("sha256").update(await readFile(join(directory, relativePath))).digest("hex"),
  ])));
  const candidateManifest = await readManifest(candidateSourceDirectory);
  const publicManifest = await readManifest(publicDirectory);
  expect(candidateManifest.modelId).toBe("anatomical-improved");
  expect(candidateManifest.extras?.wristFrameProfile, "candidate must declare the calibrated palm-MCP wrist frame contract")
    .toBe("palm-mcp-v1");
  const candidateAssetPaths = assetPathsForManifest(candidateManifest);
  const publicAssetPaths = assetPathsForManifest(publicManifest);
  expect(candidateAssetPaths).toHaveLength(13);
  expect(publicAssetPaths).toHaveLength(13);
  await mkdir(frozenCandidateDirectory, { recursive: true });
  for (const relativePath of candidateAssetPaths) {
    expect(relativePath.split("/")).not.toContain("..");
    const bytes = await readFile(join(candidateSourceDirectory, relativePath));
    const frozenPath = join(frozenCandidateDirectory, ...relativePath.split("/"));
    await mkdir(dirname(frozenPath), { recursive: true });
    await writeFile(frozenPath, bytes);
    expect(createHash("sha256").update(await readFile(frozenPath)).digest("hex"), `${relativePath} frozen package copy`)
      .toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  const candidateAssetHashes = await sha256Files(frozenCandidateDirectory, candidateAssetPaths);
  const publicAssetHashes = await sha256Files(publicDirectory, publicAssetPaths);
  const sourceFiles = [
    "apps/client/src/player/PianoPlayer.tsx",
    "apps/client/src/render3d/handRigBuilder.ts",
    "apps/client/src/render3d/pianoScene3d.ts",
    "apps/client/src/render/pianoScene.ts",
    "apps/client/src/render3d/improvedHandRuntime.ts",
  ];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async relativePath => [
    relativePath,
    createHash("sha256").update(await readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)))).digest("hex"),
  ])));
  const pageErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const candidateRoutedPaths: Array<{ path: string; status: number }> = [];
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(viewport);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/models/hands/improved/")) assetResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push({ type: message.type(), text: message.text() });
  });

  const captureVariant = async (variant: "public" | "carpal-roots-candidate") => {
    const loaded = await loadTwoHandDemoSong(page);
    await installPosedThumbProbe(page, { singleCapture: true });
    try {
      await selectAndWaitForImprovedHand(page);
    } catch (cause) {
      const failureDiagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
      const failurePath = testInfo.outputPath(`anatomical-improved-carpal-roots-${variant}-load-diagnostics.json`);
      await mkdir(dirname(failurePath), { recursive: true });
      await writeFile(failurePath, JSON.stringify({
        variant,
        poseTimeSeconds: poseTime,
        projectId: loaded.result.projectId,
        revision: loaded.result.revision,
        planIds: {
          performance: loaded.result.performancePlan?.planId ?? null,
          fingering: loaded.result.fingeringPlan?.planId ?? null,
        },
        candidateSourceDirectory,
        modelLoadDiagnostics: failureDiagnostics,
        sourceSha256,
        publicAssetHashes,
        candidateAssetHashes,
        candidateManifestExtras: candidateManifest.extras,
        candidateRoutedPaths,
        assetResponses,
        pageErrors,
        consoleMessages,
        cause: cause instanceof Error ? cause.message : String(cause),
      }, null, 2));
      await testInfo.attach(`anatomical-improved-carpal-roots-${variant}-load-diagnostics`, {
        path: failurePath,
        contentType: "application/json",
      });
      throw cause;
    }
    await seekToTime(page, poseTime);
    const activeNoteIds = new Map<string, number>();
    for (const event of loaded.result.performancePlan?.events ?? []) {
      if (event.timeSeconds > poseTime) continue;
      if (event.type === "press" && event.noteId && event.pitch != null) activeNoteIds.set(event.noteId, event.pitch);
      else if (event.type === "release" && event.noteId) activeNoteIds.delete(event.noteId);
    }
    const assignmentByNoteId = new Map((loaded.result.fingeringPlan?.assignments ?? []).map(assignment => [assignment.noteId, assignment]));
    const expectedContacts = [...activeNoteIds.entries()].flatMap(([noteId, pitch]) => {
      const assignment = assignmentByNoteId.get(noteId);
      return assignment && assignment.finger !== null
        ? [{ noteId, pitch, hand: assignment.hand, finger: assignment.finger }]
        : [];
    });
    expect(expectedContacts, `${variant} every active .75s note must have a real fingering assignment`).toHaveLength(activeNoteIds.size);
    expect(expectedContacts.some(contact => contact.hand === "left")).toBe(true);
    expect(expectedContacts.some(contact => contact.hand === "right")).toBe(true);

    const cameras: Array<{
      camera: CameraId;
      path: string;
      visibleSkinPixelCount: number;
      diagnostics: HandModelDiagnostics | null;
      posedProbe: PosedSceneProbe | null;
    }> = [];
    for (const camera of ["pov", "side_arch"] as const) {
      await setCamera(page, camera);
      await expectLoadedModel(page, "anatomical-improved");
      const posedProbe = await capturePosedThumbProbeOnce(page, poseTime);
      const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
      const screenshotPath = testInfo.outputPath(`anatomical-improved-carpal-roots-${variant}-${camera}.png`);
      const cameraJsonPath = testInfo.outputPath(`anatomical-improved-carpal-roots-${variant}-${camera}-pose.json`);
      await mkdir(dirname(cameraJsonPath), { recursive: true });
      await writeFile(cameraJsonPath, JSON.stringify({
        variant,
        poseTimeSeconds: poseTime,
        camera,
        projectId: loaded.result.projectId,
        revision: loaded.result.revision,
        expectedContacts,
        diagnostics,
        posedProbe,
        screenshotPath,
        sourceSha256,
        publicAssetHashes,
        candidateAssetHashes,
        candidateManifestExtras: candidateManifest.extras,
      }, null, 2));
      await testInfo.attach(`anatomical-improved-carpal-roots-${variant}-${camera}-pose`, {
        path: cameraJsonPath,
        contentType: "application/json",
      });
      for (const hand of ["left", "right"] as const) {
        expect(diagnostics?.[hand].requestedModel, `${variant} ${hand} requested model`).toBe("anatomical-improved");
        expect(diagnostics?.[hand].loadedModel, `${variant} ${hand} loaded model`).toBe("anatomical-improved");
        expect(diagnostics?.[hand].state, `${variant} ${hand} load state`).toBe("ready");
        expect(diagnostics?.[hand].loadedLod, `${variant} ${hand} loaded LOD`).toBeGreaterThanOrEqual(0);
        expect(diagnostics?.[hand].loadedLod, `${variant} ${hand} loaded LOD`).toBeLessThanOrEqual(2);
        const handContacts = expectedContacts.filter(contact => contact.hand === hand);
        expect(diagnostics?.[hand].activeContactTargets, `${variant} ${hand} actual assigned contact targets`)
          .toEqual(expect.arrayContaining(handContacts.map(({ pitch, finger }) => ({ pitch, finger }))));
      }
      expect(posedProbe, `${variant} ${camera} must include the actual posed runtime rig`).not.toBeNull();
      for (const hand of ["left", "right"] as const) {
        const handProbe = posedProbe!.hands[hand];
        expect(handProbe, `${variant} ${camera} ${hand} must have a live pose`).not.toBeNull();
        expect(handProbe!.poseTimeSeconds, `${variant} ${camera} ${hand} pose time`).toBeCloseTo(poseTime, 2);
        expect(handProbe!.pose, `${variant} ${camera} ${hand} source pose`).toBeTruthy();
        expect(Object.keys(handProbe!.allBones), `${variant} ${camera} ${hand} must expose all 25 rig bones`).toHaveLength(25);
        expect(handProbe!.reconstructedHandFrame.wristCenter).toHaveLength(3);
        expect(handProbe!.reconstructedHandFrame.wristR).toHaveLength(3);
        expect(handProbe!.reconstructedHandFrame.wristU).toHaveLength(3);
        expect(handProbe!.reconstructedHandFrame.armEnd).toHaveLength(3);
        for (const [boneName, bone] of Object.entries(handProbe!.allBones)) {
          expect(bone.worldMatrix, `${variant} ${camera} ${hand} ${boneName} world matrix`).toHaveLength(16);
          expect(bone.worldMatrix.every(Number.isFinite), `${variant} ${camera} ${hand} ${boneName} world matrix finite`).toBe(true);
          expect(bone.scale, `${variant} ${camera} ${hand} ${boneName} scale`).toHaveLength(3);
          expect(bone.scale.every(Number.isFinite), `${variant} ${camera} ${hand} ${boneName} scale finite`).toBe(true);
          expect(bone.bindLengthIn, `${variant} ${camera} ${hand} ${boneName} bind length`).toBeGreaterThan(0);
        }
      }
      const screenshot = await studioCanvas(page, "3d").screenshot({ path: screenshotPath });
      const visibleSkinPixelCount = countVisibleSkinPixels(screenshot);
      expect(visibleSkinPixelCount, `${variant} ${camera} hand mesh must be visible`).toBeGreaterThan(5_000);
      await testInfo.attach(`anatomical-improved-carpal-roots-${variant}-${camera}`, { path: screenshotPath, contentType: "image/png" });
      cameras.push({ camera, path: screenshotPath, visibleSkinPixelCount, diagnostics, posedProbe });
    }
    return {
      poseTimeSeconds: poseTime,
      projectId: loaded.result.projectId,
      revision: loaded.result.revision,
      planIds: {
        performance: loaded.result.performancePlan?.planId ?? null,
        fingering: loaded.result.fingeringPlan?.planId ?? null,
      },
      notesAtPose: expectedContacts,
      poseSignature: expectedContacts.map(({ pitch, hand, finger }) => ({ pitch, hand, finger }))
        .sort((a, b) => a.pitch - b.pitch || a.hand.localeCompare(b.hand) || a.finger - b.finger),
      cameras,
    };
  };

  const publicCapture = await captureVariant("public");
  const candidatePaths = new Set(candidateAssetPaths);
  const assetPrefix = "/models/hands/improved/";
  await page.route("**/models/hands/improved/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    const prefixIndex = pathname.indexOf(assetPrefix);
    const relativePath = prefixIndex >= 0 ? decodeURIComponent(pathname.slice(prefixIndex + assetPrefix.length)) : "";
    if (!candidatePaths.has(relativePath)) {
      await route.continue();
      return;
    }
    const extension = relativePath.split(".").at(-1)?.toLowerCase();
    const contentType = extension === "json" ? "application/json" : extension === "glb" ? "model/gltf-binary" :
      extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
    candidateRoutedPaths.push({ path: relativePath, status: 200 });
    await route.fulfill({ status: 200, contentType, path: join(frozenCandidateDirectory, ...relativePath.split("/")) });
  });
  const candidatePreflight = await page.evaluate(async paths => Promise.all(paths.map(async path => {
    const response = await fetch(`/models/hands/improved/${path}`);
    const body = await response.arrayBuffer();
    return { path, status: response.status, byteLength: body.byteLength };
  })), candidateAssetPaths);
  expect(candidatePreflight, "the complete frozen candidate package must route through its own manifest").toHaveLength(13);
  for (const response of candidatePreflight) {
    expect(response.status, `${response.path} candidate response`).toBe(200);
    expect(response.byteLength, `${response.path} candidate payload`).toBeGreaterThan(1_024);
  }
  const candidateCapture = await captureVariant("carpal-roots-candidate");
  expect(candidateCapture.poseSignature, "public and candidate runs must use identical actual .75s note assignments")
    .toEqual(publicCapture.poseSignature);
  for (const camera of ["pov", "side_arch"] as const) {
    const publicCamera = publicCapture.cameras.find(capture => capture.camera === camera)!;
    const candidateCamera = candidateCapture.cameras.find(capture => capture.camera === camera)!;
    expect(candidateCamera.posedProbe?.activePitches, `${camera} public and candidate must have identical live active pitches`)
      .toEqual(publicCamera.posedProbe?.activePitches);
    for (const hand of ["left", "right"] as const) {
      expect(candidateCamera.posedProbe?.hands[hand]?.pose, `${camera} ${hand} public and candidate must use the same actual source pose`)
        .toEqual(publicCamera.posedProbe?.hands[hand]?.pose);
    }
  }
  const requestedCandidateFiles = new Set(candidateRoutedPaths.map(entry => entry.path));
  expect(requestedCandidateFiles.has("manifest.json"), "the candidate's complete manifest must be routed").toBe(true);
  for (const hand of ["left", "right"] as const) {
    const loadedLod = candidateCapture.cameras[0]!.diagnostics?.[hand].loadedLod;
    expect(loadedLod).not.toBeNull();
    expect(candidateManifest.hands[hand].lods.some(lod => lod.level === loadedLod), `${hand} loaded LOD must be declared by the candidate manifest`).toBe(true);
    expect(requestedCandidateFiles.has(`${hand}-lod${loadedLod}.glb`), `the candidate ${hand} LOD${loadedLod} must be routed`).toBe(true);
    const textureSetName = candidateManifest.hands[hand].lods.find(lod => lod.level === loadedLod)?.textureSet;
    if (textureSetName) {
      const textureSet = candidateManifest.textures[textureSetName];
      expect(textureSet, `${hand} LOD${loadedLod} texture set must exist in the candidate manifest`).toBeTruthy();
      for (const texturePath of Object.values(textureSet!)) {
        if (typeof texturePath === "string" && texturePath.startsWith("textures/")) {
          expect(requestedCandidateFiles.has(texturePath), `${hand} ${textureSetName} texture must be routed from the candidate`).toBe(true);
        }
      }
    }
  }
  expect((await sha256Files(candidateSourceDirectory, candidateAssetPaths)), "candidate source assets must remain unchanged during A/B")
    .toEqual(candidateAssetHashes);
  expect((await sha256Files(publicDirectory, publicAssetPaths)), "public assets must remain immutable during A/B")
    .toEqual(publicAssetHashes);
  expect(assetResponses.filter(response => response.status >= 400)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleMessages.filter(message => /shader|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text))).toEqual([]);
  await testInfo.attach("anatomical-improved-carpal-roots-ab-report", {
    contentType: "application/json",
    body: JSON.stringify({
      viewport,
      poseTimeSeconds: poseTime,
      candidateSourceDirectory,
      frozenCandidateDirectory,
      publicManifest: { modelId: publicManifest.modelId, assetHashes: publicAssetHashes },
      candidateManifest: { modelId: candidateManifest.modelId, extras: candidateManifest.extras, assetHashes: candidateAssetHashes },
      sourceSha256,
      publicCapture,
      candidateCapture,
      posedProbeClassification: "Each variant/camera record contains the current actual runtime lastPose and all 25 loaded rig-bone local transforms, world matrices, scales, and bind lengths, plus reconstructed source pose/wrist frame. Source poses are equality-checked across public and candidate runs; reconstructed values remain pose diagnostics, while bone matrices describe the actual selected and skinned model.",
      candidatePreflight,
      candidateRoutedPaths,
      assetResponses,
      consoleMessages,
      pageErrors,
      comparisonScope: "The public run and candidate run use the same demo MIDI, actual .75s note assignments, 1440x900 viewport, POV and Side Arch cameras. Candidate assets are copied to a test-output freeze and all 13 manifest-referenced files are preflight-fetched through routing; the actual Studio run loads the candidate manifest, selected GLBs, and assigned textures. LOD is derived from actual runtime diagnostics.",
    }, null, 2),
  });
});

test("capture a one-view topological candidate wrist and 25-bone transform probe", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const poseTime = 0.75;
  const candidateFiles = {
    left: fileURLToPath(new URL("../../scratch/improved-qa/frozen-topological-lod1/left-lod1.glb", import.meta.url)),
    right: fileURLToPath(new URL("../../scratch/improved-qa/frozen-topological-lod1/right-lod1.glb", import.meta.url)),
  };
  const sourceFiles = [
    "apps/client/src/render3d/handRigBuilder.ts",
    "apps/client/src/render3d/pianoScene3d.ts",
    "apps/client/src/render3d/improvedHandRuntime.ts",
  ];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async relativePath => [
    relativePath,
    createHash("sha256").update(await readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)))).digest("hex"),
  ])));
  const candidateSha256 = Object.fromEntries(await Promise.all(Object.entries(candidateFiles).map(async ([hand, path]) => [
    hand,
    createHash("sha256").update(await readFile(path)).digest("hex"),
  ])));
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/models/hands/improved/")) assetResponses.push({ url: response.url(), status: response.status() });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/models/hands/improved/left-lod1.glb", route => route.fulfill({
    status: 200,
    contentType: "model/gltf-binary",
    path: candidateFiles.left,
  }));
  await page.route("**/models/hands/improved/right-lod1.glb", route => route.fulfill({
    status: 200,
    contentType: "model/gltf-binary",
    path: candidateFiles.right,
  }));
  const loaded = await loadTwoHandDemoSong(page);
  await installPosedThumbProbe(page);
  await selectAndWaitForImprovedHand(page);
  await seekToTime(page, poseTime);
  await setCamera(page, "pov");
  await expect.poll(() => page.evaluate(() => window.__anatomicalPoseProbe?.viewTime ?? null), { timeout: 10_000 })
    .toBeCloseTo(poseTime, 1);
  const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
  expect(diagnostics?.left.loadedLod).toBe(1);
  expect(diagnostics?.right.loadedLod).toBe(1);
  const posedProbe = await page.evaluate(() => window.__anatomicalPoseProbe ?? null);
  expect(posedProbe?.hands.left?.allBones && Object.keys(posedProbe.hands.left.allBones)).toHaveLength(25);
  expect(posedProbe?.hands.right?.allBones && Object.keys(posedProbe.hands.right.allBones)).toHaveLength(25);
  const screenshotName = "anatomical-improved-topological-candidate-pov-all-bones.png";
  const screenshotPath = testInfo.outputPath(screenshotName);
  const screenshot = await studioCanvas(page, "3d").screenshot({ path: screenshotPath });
  const visibleSkinPixelCount = countVisibleSkinPixels(screenshot);
  expect(visibleSkinPixelCount).toBeGreaterThan(5_000);
  await testInfo.attach("anatomical-improved-topological-candidate-pov-all-bones", {
    path: screenshotPath,
    contentType: "image/png",
  });
  const activeNotes = new Map<string, number>();
  const pitchByNoteId = new Map<string, number>();
  for (const event of loaded.result.performancePlan?.events ?? []) {
    if (event.type === "press" && event.noteId && event.pitch != null) pitchByNoteId.set(event.noteId, event.pitch);
    if (event.timeSeconds > poseTime) continue;
    if (event.type === "press" && event.noteId && event.pitch != null) activeNotes.set(event.noteId, event.pitch);
    else if (event.type === "release" && event.noteId) activeNotes.delete(event.noteId);
  }
  const assignments = new Map((loaded.result.fingeringPlan?.assignments ?? []).map(assignment => [assignment.noteId, assignment]));
  const notesAtPose = [...activeNotes.entries()].map(([noteId, pitch]) => ({
    noteId,
    pitch,
    assignment: assignments.get(noteId) ?? null,
    pressTimeSeconds: (loaded.result.performancePlan?.events ?? []).find(event => event.type === "press" && event.noteId === noteId)?.timeSeconds ?? null,
    releaseTimeSeconds: (loaded.result.performancePlan?.events ?? []).find(event => event.type === "release" && event.noteId === noteId)?.timeSeconds ?? null,
  }));
  expect(pageErrors).toEqual([]);
  expect(consoleMessages.filter(message => /shader|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text))).toEqual([]);
  await testInfo.attach("anatomical-improved-topological-candidate-all-bones-data", {
    contentType: "application/json",
    body: JSON.stringify({
      poseTimeSeconds: poseTime,
      camera: "pov",
      viewport: { width: 1440, height: 900 },
      notesAtPose,
      handModelDiagnostics: diagnostics,
      posedProbe,
      visibleSkinPixelCount,
      sourceSha256,
      candidateSha256,
      assetResponses,
      consoleMessages,
      pageErrors,
      runtimeContext: "One static t=.75s active-MIDI pose, frozen topological LOD1 GLBs, same dev runtime, one POV capture; QA Vite HMR is disabled.",
    }, null, 2),
  });
});

test("rest meshes render as textured, clay, and skin-weight/skeleton source views", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const draftLod1 = process.env.PIANOMOTION_DRAFT_LOD1 === "1";
  const compareTextures = process.env.PIANOMOTION_TEXTURE_COMPARE === "1";
  const frozenDraftDir = fileURLToPath(new URL("../../scratch/draftmanifestlog/frozen-assets/models/hands/improved/", import.meta.url))
    .replaceAll("\\", "/");
  const frozenFinalDir = fileURLToPath(new URL("../../scratch/improved-qa/frozen-final/models/hands/improved/", import.meta.url))
    .replaceAll("\\", "/");
  const frozenDraftBase = `/@fs/${frozenDraftDir}/`;
  const frozenFinalBase = `/@fs/${frozenFinalDir}/`;
  const frozenCandidateDir = fileURLToPath(new URL("../../scratch/improved-qa/frozen-optimized-textures/", import.meta.url))
    .replaceAll("\\", "/");
  const frozenCandidateBase = `/@fs/${frozenCandidateDir}/`;
  const labels = compareTextures
    ? ["Left · reference textures", "Left · optimized textures", "Right · reference textures", "Right · optimized textures"]
    : ["Left · textured", "Left · clay", "Left · weights + skeleton", "Right · textured", "Right · clay", "Right · weights + skeleton"];
  const gridColumns = compareTextures ? 2 : 3;
  const cellSize = compareTextures ? 640 : 480;
  const canvasWidth = gridColumns * cellSize;
  const canvasHeight = 2 * cellSize;
  const bareViewerHtml = `
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Improved hand source viewer</title></head>
    <body style="margin:0;background:#101216">
    <main id="viewer-layout" style="background:#101216;color:#eef1f5;font:16px sans-serif;padding:12px;width:max-content">
      <h1>Improved hand ${draftLod1 ? "draft LOD1" : "LOD0"} rest mesh inspection</h1>
      <p>${compareTextures ? "Same LOD0 mesh, camera, and lighting: full-quality references versus optimized candidate textures." : "Rows: left / right. Columns: source texture / grey clay / dominant skin weights with skeleton."}</p>
      <div id="viewer-grid" style="position:relative;width:${canvasWidth}px;height:${canvasHeight}px;overflow:hidden;background:#171a1e">
        <canvas id="source-viewer-canvas" width="${canvasWidth}" height="${canvasHeight}" style="position:absolute;inset:0;display:block"></canvas>
        <div style="position:absolute;inset:0;display:grid;grid-template-columns:repeat(${gridColumns},${cellSize}px);grid-template-rows:repeat(2,${cellSize}px);pointer-events:none">
          ${labels.map(label => `<span style="box-sizing:border-box;padding:8px;color:#eef1f5;text-shadow:0 1px 3px #000;background:#171a1eaa;border:1px solid #41464e">${label}</span>`).join("")}
        </div>
      </div>
    </main>
    </body></html>
  `;
  await page.route("**/draft-hand-viewer**", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: bareViewerHtml,
  }));
  const viewerBase = draftLod1 ? frozenDraftBase : frozenFinalBase;
  const viewerQuery = `?${draftLod1 ? "draft=lod1&" : ""}${compareTextures ? "compareTextures=1&" : ""}` +
    `assetBase=${encodeURIComponent(viewerBase)}` +
    (compareTextures ? `&candidateTextureBase=${encodeURIComponent(frozenCandidateBase)}` : "");
  await page.goto(`/draft-hand-viewer${viewerQuery}`);
  const modulePath = fileURLToPath(new URL("./anatomical-improved-source-viewer.ts", import.meta.url)).replaceAll("\\", "/");
  await page.addScriptTag({ url: `/@fs/${modulePath}`, type: "module" });
  await expect.poll(() => page.evaluate(() => window.__anatomicalSourceViewerResult?.status ?? null), {
    timeout: 90_000,
    intervals: [250, 500, 1000],
  }).toMatch(/ready|error/);
  const result = await page.evaluate(() => window.__anatomicalSourceViewerResult!);
  expect(result.status, result.error ?? "source viewer must complete successfully").toBe("ready");
  expect(result.sourceMode).toBe(compareTextures ? "texture-compare-lod0" : draftLod1 ? "draft-lod1" : "manifest-lod0");
  for (const hand of ["left", "right"] as const) {
    expect(result.hands[hand].triangleCount).toBeGreaterThan(0);
    expect(result.hands[hand].weightedVertices).toBeGreaterThan(0);
    expect(result.hands[hand].skeletonBones).toBeGreaterThan(0);
  }
  if (draftLod1) {
    expect(result.assetUrls.some(url => url.endsWith("/left-lod1.glb"))).toBe(true);
    expect(result.assetUrls.some(url => url.endsWith("/right-lod1.glb"))).toBe(true);
    expect(result.assetUrls.some(url => url.endsWith("/manifest.json"))).toBe(false);
  } else {
    expect(result.assetUrls.some(url => url.endsWith("/manifest.json"))).toBe(true);
    expect(result.assetUrls.some(url => url.endsWith("/left-lod0.glb"))).toBe(true);
    expect(result.assetUrls.some(url => url.endsWith("/right-lod0.glb"))).toBe(true);
  }
  if (compareTextures) {
  expect(result.assetUrls.filter(url => url.includes("/frozen-optimized-textures/")).length).toBeGreaterThanOrEqual(3);
    expect(result.textureComparison?.reference.baseColor).toBe("textures/base-color-2048.jpg");
  expect(result.textureComparison?.candidateBase).toContain("frozen-optimized-textures");
  }
  const screenshotName = compareTextures
    ? "anatomical-improved-texture-comparison-reference-vs-optimized.png"
    : draftLod1
      ? "anatomical-improved-draft-lod1-rest-mesh-viewer.png"
      : "anatomical-improved-rest-mesh-viewer.png";
  await page.locator("#viewer-layout").screenshot({ path: testInfo.outputPath(screenshotName) });
  await testInfo.attach(compareTextures
    ? "anatomical-improved-texture-comparison-reference-vs-optimized"
    : draftLod1 ? "anatomical-improved-draft-lod1-rest-mesh-viewer" : "anatomical-improved-rest-mesh-viewer", {
    path: testInfo.outputPath(screenshotName),
    contentType: "image/png",
  });
  await testInfo.attach("anatomical-improved-rest-mesh-viewer-data", {
    contentType: "application/json",
    body: JSON.stringify(result, null, 2),
  });
});

test("actual engine articulation matrix captures assigned notes, posed hands, and key-top footprints", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = { width: 1440, height: 900 };
  const pageErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string }> = [];
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("response", response => {
    if (response.url().includes("/models/hands/")) assetResponses.push({ url: response.url(), status: response.status() });
  });
  await page.setViewportSize(viewport);
  const loaded = await loadArticulationMatrixSong(page);
  const performanceEvents = loaded.result.performancePlan?.events ?? [];
  const assignments = loaded.result.fingeringPlan?.assignments ?? [];
  const assignmentByNoteId = new Map(assignments.map(assignment => [assignment.noteId, assignment]));
  const pressEvents = performanceEvents.flatMap(event =>
    event.type === "press" && event.noteId && event.pitch != null ? [{
      noteId: event.noteId,
      pitch: event.pitch,
      timeSeconds: event.timeSeconds,
    }] : [],
  );
  const releaseByNoteId = new Map(performanceEvents.flatMap(event =>
    event.type === "release" && event.noteId ? [[event.noteId, event.timeSeconds] as const] : [],
  ));
  const plannedNotes = pressEvents.map(event => {
    const assignment = assignmentByNoteId.get(event.noteId);
    return {
      ...event,
      endSeconds: releaseByNoteId.get(event.noteId) ?? null,
      hand: assignment?.hand ?? null,
      finger: assignment?.finger ?? null,
    };
  });
  expect(pressEvents.length, "all notes from the generated MIDI must reach the actual performance plan").toBe(articulationMatrixNotes.length);
  expect(plannedNotes.every(note => note.hand !== null && note.finger !== null),
    "the actual fingering plan must assign every matrix note to a hand and finger").toBe(true);
  expect(loaded.result.performancePlan?.fingeringPlanId).toBe(loaded.result.fingeringPlan?.planId);
  expect(loaded.result.motionPlan?.performancePlanId).toBe(loaded.result.performancePlan?.planId);

  const activeNotesAt = (timeSeconds: number) => plannedNotes.filter(note =>
    note.timeSeconds <= timeSeconds && note.endSeconds !== null && note.endSeconds > timeSeconds,
  );
  const eventsInSection = (section: keyof typeof articulationMatrixWindows) => {
    const bounds = articulationMatrixWindows[section];
    return plannedNotes.filter(note => note.timeSeconds >= bounds.startSeconds && note.timeSeconds < bounds.endSeconds);
  };
  const poseTimeForPitches = (section: keyof typeof articulationMatrixWindows, pitches: number[]) => {
    const bounds = articulationMatrixWindows[section];
    const span = bounds.endSeconds - bounds.startSeconds;
    const candidates = Array.from({ length: Math.ceil(span / 0.01) }, (_, index) => bounds.startSeconds + index * 0.01);
    return candidates.find(timeSeconds => {
      const active = activeNotesAt(timeSeconds);
      return pitches.every(pitch => active.some(note => note.pitch === pitch));
    }) ?? null;
  };
  const sectionEvents = {
    white: eventsInSection("single-white"),
    black: eventsInSection("single-black"),
    chord: eventsInSection("chord"),
    octave: eventsInSection("octave"),
    scale: eventsInSection("scale"),
    fastRun: eventsInSection("fast-run"),
  };
  expect(sectionEvents.white.map(note => note.pitch)).toEqual([64]);
  expect(sectionEvents.black.map(note => note.pitch)).toEqual([61]);
  expect(sectionEvents.chord.map(note => note.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  expect(sectionEvents.octave.map(note => note.pitch).sort((a, b) => a - b)).toEqual([48, 60]);
  expect(sectionEvents.scale.map(note => note.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  expect(sectionEvents.fastRun.map(note => note.pitch)).toEqual([72, 71, 69, 67, 65, 64, 62, 60]);
  for (const [name, events] of Object.entries(sectionEvents)) {
    expect(events.every(note => note.endSeconds !== null && note.finger !== null), `${name} source events need release and fingering assignments`).toBe(true);
  }

  const whitePoseTime = poseTimeForPitches("single-white", [64]);
  const blackPoseTime = poseTimeForPitches("single-black", [61]);
  const chordPoseTime = poseTimeForPitches("chord", [60, 64, 67]);
  const octavePoseTime = poseTimeForPitches("octave", [48, 60]);
  const scalePoseTime = poseTimeForPitches("scale", [65]);
  const fastRunPoseTime = poseTimeForPitches("fast-run", [67]);
  expect(whitePoseTime, "white-key note must be active in the real plan").not.toBeNull();
  expect(blackPoseTime, "black-key note must be active in the real plan").not.toBeNull();
  expect(chordPoseTime, "the three-note chord must overlap in the real plan").not.toBeNull();
  expect(octavePoseTime, "the octave must overlap in the real plan").not.toBeNull();
  expect(scalePoseTime, "an ascending scale note must be active in the real plan").not.toBeNull();
  expect(fastRunPoseTime, "a fast-run note must be active in the real plan").not.toBeNull();
  const fastOnsetIntervals = sectionEvents.fastRun.slice(1).map((note, index) => note.timeSeconds - sectionEvents.fastRun[index]!.timeSeconds);
  expect(Math.max(...fastOnsetIntervals), "the actual plan should keep each fast-run onset within 200 ms").toBeLessThanOrEqual(0.2);

  const scaleThumbTransitionCandidates = sectionEvents.scale.slice(1).flatMap((note, index) => {
    const previous = sectionEvents.scale[index]!;
    return previous.hand === note.hand && previous.finger !== null && note.finger === 1 && previous.finger >= 3 && note.pitch > previous.pitch
      ? [{ hand: note.hand, fromPitch: previous.pitch, fromFinger: previous.finger, toPitch: note.pitch, timeSeconds: note.timeSeconds }]
      : [];
  });
  await installPosedThumbProbe(page);
  await selectAndWaitForImprovedHand(page);
  await installLiveNoteSourceProbe(page);
  await installActualKeyFootprintProbe(page);

  const capturePose = async (category: string, timeSeconds: number) => {
    await seekToTime(page, timeSeconds);
    const currentTime = (await browserSnapshot(page))?.currentTimeSeconds ?? timeSeconds;
    const expectedActive = activeNotesAt(currentTime);
    expect(expectedActive.length, `${category} pose must contain assigned active MIDI notes`).toBeGreaterThan(0);
    const expectedContacts = expectedActive.flatMap(note => note.hand && note.finger !== null
      ? [{ noteId: note.noteId, pitch: note.pitch, hand: note.hand, finger: note.finger }]
      : []);
    const liveSource = await page.evaluate(current => {
      const records = window.__anatomicalLiveNoteSourceProbe ?? [];
      return [...records].reverse().find(record => Math.abs(record.currentTransportTime - current) < 0.03) ?? null;
    }, currentTime);
    expect(liveSource, `${category} must be captured from the live Studio scene`).not.toBeNull();
    expect(liveSource!.performancePlanPresent).toBe(true);
    expect(liveSource!.noteSource).toBe("renderedNoteTimings");
    for (const expected of expectedContacts) {
      expect(liveSource!.activeNoteSource.some(note => note.noteId === expected.noteId && note.pitch === expected.pitch &&
        note.hand === expected.hand && note.finger === expected.finger), `${category} live note source must retain the Worker assignment`).toBe(true);
    }

    const cameraCaptures: any[] = [];
    for (const camera of ["pov", "side_arch"] as const) {
      await setCamera(page, camera);
      await expectLoadedModel(page, "anatomical-improved");
      const diagnostics = (await browserSnapshot(page))?.handModelDiagnostics ?? null;
      expect(diagnostics).toBeTruthy();
      for (const expected of expectedContacts) {
        expect(diagnostics![expected.hand].activeContactTargets).toContainEqual({ pitch: expected.pitch, finger: expected.finger });
      }
      const path = testInfo.outputPath(`anatomical-improved-matrix-${category}-${camera}.png`);
      const png = await studioCanvas(page, "3d").screenshot({ path });
      const visibleSkinPixelCount = countVisibleSkinPixels(png);
      expect(visibleSkinPixelCount, `${category} ${camera} must render the selected hand model`).toBeGreaterThan(5_000);
      await testInfo.attach(`anatomical-improved-matrix-${category}-${camera}`, { path, contentType: "image/png" });
      const posedProbe = await page.evaluate(() => window.__anatomicalPoseProbe ?? null);
      expect(posedProbe?.hands.left?.pose).toBeTruthy();
      expect(posedProbe?.hands.right?.pose).toBeTruthy();
      const actualKeyFootprints = await page.evaluate(() => window.__anatomicalActualKeyFootprintProbe?.() ?? null);
      expect(actualKeyFootprints, `${category} must query actual skinned vertices against the assigned pressed key meshes`).not.toBeNull();
      for (const expected of expectedContacts) {
        const footprint = actualKeyFootprints!.find(row => row.hand === expected.hand && row.pitch === expected.pitch && row.finger === expected.finger);
        expect(footprint, `${category} must include the active ${expected.hand} pitch ${expected.pitch} finger ${expected.finger}`).toBeTruthy();
        expect(footprint!.eligibleDistalVertices).toBeGreaterThan(0);
        expect(footprint!.keyDepressionRadians, `${category} must sample the currently depressed assigned key`).toBeGreaterThan(0);
        expect(footprint!.verticesOnAssignedKeyTop, `${category} distal skin vertices must intersect the assigned key footprint`).toBeGreaterThan(0);
        expect(Object.values(footprint!.penetrationCounts).every(Number.isFinite)).toBe(true);
      }
      cameraCaptures.push({ camera, path, visibleSkinPixelCount, diagnostics, posedProbe, actualKeyFootprints });
    }
    return { category, requestedPoseTimeSeconds: timeSeconds, capturedPoseTimeSeconds: currentTime, expectedContacts, liveSource, cameraCaptures };
  };

  const categoryCaptures: any[] = [];
  categoryCaptures.push(await capturePose("single-white", whitePoseTime!));
  categoryCaptures.push(await capturePose("single-black", blackPoseTime!));
  categoryCaptures.push(await capturePose("chord", chordPoseTime!));
  categoryCaptures.push(await capturePose("octave", octavePoseTime!));
  categoryCaptures.push(await capturePose("scale", scalePoseTime!));
  categoryCaptures.push(await capturePose("fast-run", fastRunPoseTime!));

  const captureSequenceProbes = async (events: typeof sectionEvents.scale) => {
    const records: any[] = [];
    for (const event of events) {
      const noteEnd = event.endSeconds ?? event.timeSeconds + 0.1;
      const sampleTime = event.timeSeconds + Math.min(0.08, Math.max(0.02, (noteEnd - event.timeSeconds) * 0.5));
      await seekToTime(page, sampleTime);
      const currentTime = (await browserSnapshot(page))?.currentTimeSeconds ?? sampleTime;
      await expect.poll(() => page.evaluate(current => {
        const poseTime = window.__anatomicalPoseProbe?.viewTime;
        const liveRecords = window.__anatomicalLiveNoteSourceProbe ?? [];
        return poseTime !== undefined && Math.abs(poseTime - current) < 0.03 &&
          liveRecords.some(record => Math.abs(record.currentTransportTime - current) < 0.03);
      }, currentTime), { timeout: 10_000, intervals: [100, 250, 500] })
        .toBe(true);
      const activeNotes = activeNotesAt(currentTime);
      expect(activeNotes.length, "each sequence sample must overlap an assigned Worker note").toBeGreaterThan(0);
      const posedProbe = await page.evaluate(() => window.__anatomicalPoseProbe ?? null);
      expect(posedProbe?.hands.left?.pose).toBeTruthy();
      expect(posedProbe?.hands.right?.pose).toBeTruthy();
      const liveSource = await page.evaluate(current => {
        const records = window.__anatomicalLiveNoteSourceProbe ?? [];
        return [...records].reverse().find(record => Math.abs(record.currentTransportTime - current) < 0.03) ?? null;
      }, currentTime);
      expect(liveSource?.noteSource).toBe("renderedNoteTimings");
      const actualKeyFootprints = await page.evaluate(() => window.__anatomicalActualKeyFootprintProbe?.() ?? null);
      expect(actualKeyFootprints).not.toBeNull();
      for (const note of activeNotes) {
        const footprint = actualKeyFootprints!.find(row => row.hand === note.hand && row.pitch === note.pitch && row.finger === note.finger);
        expect(footprint, `sequence pitch ${note.pitch} must sample its assigned key`).toBeTruthy();
        expect(footprint!.eligibleDistalVertices).toBeGreaterThan(0);
        expect(footprint!.keyDepressionRadians).toBeGreaterThan(0);
        expect(footprint!.verticesOnAssignedKeyTop).toBeGreaterThan(0);
        expect(liveSource!.activeNoteSource.some(source => source.noteId === note.noteId && source.pitch === note.pitch &&
          source.hand === note.hand && source.finger === note.finger)).toBe(true);
      }
      records.push({
        sourceEvent: event,
        currentTimeSeconds: currentTime,
        activeNotes,
        liveSource,
        posedProbe,
        actualKeyFootprints,
      });
    }
    return records;
  };
  const scaleSequence = await captureSequenceProbes(sectionEvents.scale);
  const fastRunSequence = await captureSequenceProbes(sectionEvents.fastRun);
  const thumbUnderCapture = scaleThumbTransitionCandidates.length > 0
    ? await capturePose("scale-thumb-transition-review", scaleThumbTransitionCandidates[0]!.timeSeconds + 0.04)
    : null;
  const thumbUnderAssessment = scaleThumbTransitionCandidates.length > 0
    ? "the actual fingering assignments contain an ascending same-hand finger change to thumb; one live pose and POV/Side Arch screenshots are captured for review, without asserting a visually observed thumb-under gesture"
    : "no ascending same-hand finger change to thumb was present in the actual fingering assignments";
  const sourceFiles = [
    "apps/client/src/player/PianoPlayer.tsx",
    "apps/client/src/render3d/handRigBuilder.ts",
    "apps/client/src/render3d/pianoScene3d.ts",
    "apps/client/src/render3d/improvedHandRuntime.ts",
    "apps/client/src/render3d/improvedHandAssets.ts",
    "apps/client/src/render/pianoScene.ts",
    "apps/client/src/render3d/keyboard3dView.ts",
  ];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async relativePath => [
    relativePath,
    createHash("sha256").update(await readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)))).digest("hex"),
  ])));

  expect(assetResponses.filter(response => response.status >= 400)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleMessages.filter(message => /shader.*error|vertexAttrib|WebGL.*error|GL_INVALID/i.test(message.text))).toEqual([]);
  const report = {
    fixture: "generated in browser test as anatomical-improved-articulation-matrix.mid",
    midiNotes: articulationMatrixNotes,
    viewport,
    sourceSha256,
    planIds: {
      performance: loaded.result.performancePlan?.planId,
      fingering: loaded.result.fingeringPlan?.planId,
      motion: loaded.result.motionPlan?.planId,
    },
    actualEngineContract: "Settled Studio worker result; source assignments from fingeringPlan; event times from performancePlan; runtime note-source probe must report renderedNoteTimings; hand probes read the applied renderer rig.",
    categories: categoryCaptures,
    scaleSequence,
    fastRunSequence,
    scaleThumbTransitionCandidates,
    thumbUnderCapture,
    thumbUnderAssessment,
    assetResponses,
    consoleMessages,
    pageErrors,
    poseProbeClassification: "reconstructedThumbChainWorldInches and reconstructedFingerChainsWorldInches are reconstructed pose diagnostics. palmarDistalSupportWorldYByFinger comes from skinned vertices in world space but has no assigned-key footprint and is not a contact verdict.",
    contactMeasurement: "Actual skinned vertices with distal-bone influence >= 0.2 are transformed through the loaded SkinnedMesh. Only vertices inside the assigned pitch's actual top-face raycast footprint are included; Keyboard3DView.sampleKeySurfaceYAt reads the current transformed top face, and keyDepressionRadians must be positive. Negative gap is geometric penetration. This measures mesh/key geometry only, without a force or contact-physics model.",
  };
  await testInfo.attach("anatomical-improved-actual-engine-articulation-matrix", {
    contentType: "application/json",
    body: JSON.stringify(report, null, 2),
  });
});


test("Testing hand: WebXR-driven anatomical surface in POV and Side Arch", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = await loadTwoHandDemoSong(page);
  const originalPlanId = initial.result.performancePlan?.planId ?? null;
  const canvas = studioCanvas(page, "3d");
  await expect(canvas).toBeVisible();

  // Same performance and time under all three skins: only the visual hand
  // implementation changes. Screenshots are evidence, not visual acceptance.
  for (const model of ["webxr", "anatomical", "testing"] as const) {
    await page.getByRole("button", { name: "Open preferences", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
    const modelSelector = dialog.locator("#settings-hand-model");
    await modelSelector.selectOption(model);
    await expect(modelSelector).toHaveValue(model);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expectLoadedModel(page, model);
    // Hold exactly the same moment of the score for all surface variants.
    await seekToTime(page, 0.75);
    for (const camera of ["pov", "side_arch"] as const) {
      await setCamera(page, camera);
      await expect(canvas).toBeVisible();
      await canvas.screenshot({ path: testInfo.outputPath(`testing-hand-${model}-${camera}.png`) });
    }
    const diagnostic = (await browserSnapshot(page))?.handModelDiagnostics;
    expect(diagnostic?.left.loadedModel).toBe(model);
    expect(diagnostic?.right.loadedModel).toBe(model);
  }
  expect((await browserSnapshot(page))?.performancePlanId).toBe(originalPlanId);
});


// Separate Chromium captures per model so an expensive camera change or
// GPU-stalled animation frame in one model cannot invalidate all 48 images.
for (const comparedModel of ["webxr", "anatomical", "anatomical-improved", "testing"] as const) {
test("Testing hand: matched WebGL model and camera evidence / " + comparedModel, async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  test.skip(Boolean(process.env.PIANOMOTION_EVIDENCE_MODEL) &&
    process.env.PIANOMOTION_EVIDENCE_MODEL !== comparedModel,
    "This CI shard captures only its assigned hand model.");
  await page.setViewportSize({ width: 1280, height: 800 });
  const initial = await loadTwoHandDemoSong(page);
  const originalPlanId = initial.result.performancePlan?.planId ?? null;
  expect(originalPlanId).toBeTruthy();

  // All four options must play the *same* performance plan at the *same*
  // transport timestamps. Only their rendered hands and camera angles vary.
  // Keep evidence even if a visual defect is discovered later. A successful
  // capture is not, by itself, anatomical/animation acceptance.
  const comparedModels: readonly HandModelId[] = [comparedModel];
  // Fast per-PR render gate: 2 poses x 2 camera angles. A full four-camera
  // three-pose comparison remains available with PIANOMOTION_EVIDENCE_FULL=1.
  const fullReview = process.env.PIANOMOTION_EVIDENCE_FULL === "1";
  const comparisonCameras = fullReview ? cameras : (["pov", "side_arch"] as const);
  const comparedTimes = fullReview ? ([0.75, 3, 6] as const) : ([0.75, 3] as const);
  const evidence: Array<{
    model: HandModelId;
    timeSeconds: number;
    performancePlanId: string | null;
    transportTimeSeconds: number | null;
    sceneTimeSeconds: number | null;
    left: HandDiagnostics;
    right: HandDiagnostics;
    screenshots: string[];
  }> = [];

  for (const model of comparedModels) {
    await selectHandModel(page, model);
    await expectLoadedModel(page, model);
    await expect(studioCanvas(page, "3d")).toBeVisible({ timeout: 30_000 });

    for (const timeSeconds of comparedTimes) {
      await seekToTime(page, timeSeconds);
      // Wait for the 3D scene to consume the seek before capturing WebGL.
      // A suspended/throttled headless WebGL RAF may never fire; do not block
      // the entire comparison on frame callbacks.
      await page.waitForTimeout(100);
      const snapshot = await browserSnapshot(page);
      expect(snapshot?.performancePlanId).toBe(originalPlanId);
      expect(snapshot?.currentTimeSeconds).toBeCloseTo(timeSeconds, 1);
      expect(snapshot?.handModelDiagnostics?.left).toMatchObject({
        requestedModel: model,
        loadedModel: model,
        state: "ready",
        error: null,
      });
      expect(snapshot?.handModelDiagnostics?.right).toMatchObject({
        requestedModel: model,
        loadedModel: model,
        state: "ready",
        error: null,
      });
      const record = {
        model,
        timeSeconds,
        performancePlanId: snapshot!.performancePlanId,
        transportTimeSeconds: snapshot!.currentTimeSeconds,
        sceneTimeSeconds: snapshot!.sceneTime,
        left: snapshot!.handModelDiagnostics!.left,
        right: snapshot!.handModelDiagnostics!.right,
        screenshots: [] as string[],
      };

      for (const camera of comparisonCameras) {
        await setCamera(page, camera);
        await page.waitForTimeout(100);
        const filename = "testing-ab-" + model + "-" + camera + "-" +
          timeSeconds.toString().replace(".", "_") + "s.png";
        // Do not use canvas.screenshot: a continuously redrawn canvas never
        // meets Playwright's stable-element prerequisite.
        await page.screenshot({
          path: testInfo.outputPath(filename),
          animations: "disabled",
          timeout: 45_000,
        });
        record.screenshots.push(filename);
      }
      evidence.push(record);
    }
  }

  // Still-image comparison is insufficient: the Testing hand must actually
  // advance its Three.js render loop and hand motion while the MIDI plays.
  // Software-rendered CI frame times are diagnostic, not hardware FPS targets.
  await seekToTime(page, 0.75);
  const playbackProbe = await sampleAnimatedRender(page, 80);
  expect(playbackProbe.renderedFrames).toBeGreaterThan(0);
  expect(playbackProbe.handUpdateFrames).toBeGreaterThan(0);
  await writeFile(
    testInfo.outputPath("testing-hand-playback-diagnostics.json"),
    JSON.stringify(playbackProbe, null, 2),
    "utf8",
  );
  const summary = {
    originalPerformancePlanId: originalPlanId,
    cameraPresets: comparisonCameras,
    sampledTimesSeconds: comparedTimes,
    records: evidence,
    reviewRequired: [
      "MCP/PIP/DIP folds", "thumb web/opposition", "wrist seams",
      "finger intersections", "nails", "white/black-key contact",
      "continuous movement and exported video",
    ],
  };
  const evidenceJson = JSON.stringify(summary, null, 2);
  // Direct files, in addition to Playwright attachments, make the downloaded
  // CI ZIP usable without opening an HTML test reporter.
  await writeFile(testInfo.outputPath("testing-hand-evidence.json"), evidenceJson, "utf8");
  await testInfo.attach("testing-hand-matched-model-camera-evidence", {
    body: evidenceJson,
    contentType: "application/json",
  });

  // Offline contact sheet: open this HTML beside the PNGs after extracting
  // the CI artifact. Each cell links to its full-resolution reference frame.
  // No visual automatic threshold is imposed on skin appearance or motion.
  const rows = comparedTimes.map(timeSeconds => {
    const camerasAtTime = comparisonCameras.map(camera => {
      const frames = comparedModels.map(model => {
        const filename = "testing-ab-" + model + "-" + camera + "-" +
          timeSeconds.toString().replace(".", "_") + "s.png";
        return "<figure><a href=\"" + filename + "\"><img loading=\"lazy\" src=\"" +
          filename + "\" alt=\"" + model + ", " + camera + ", " + timeSeconds +
          " s\"></a><figcaption>" + model + "</figcaption></figure>";
      }).join("");
      return "<h3>" + camera + "</h3><div class=\"grid\">" + frames + "</div>";
    }).join("");
    return "<section><h2>Score time: " + timeSeconds + " s</h2>" + camerasAtTime + "</section>";
  }).join("");
  const reviewHtml = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Testing hand / matched visual review</title><style>" +
    "body{margin:24px;background:#16191e;color:#f3f4f7;font:14px system-ui,sans-serif}" +
    "section{margin:24px 0 50px}h3{margin:20px 0 8px;text-transform:capitalize}" +
    ".grid{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:10px}" +
    "figure{margin:0;background:#272c32;border-radius:6px;overflow:hidden}" +
    "img{width:100%;height:auto;display:block}figcaption{padding:8px}" +
    "a{color:inherit}p{max-width:900px;line-height:1.5}" +
    "@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
    "</style><h1>Testing hand — matched model review</h1>" +
    "<p>Same performance plan and score time, four hand models and four cameras. " +
    "Click any image to inspect the full-resolution frame. These stills are evidence " +
    "for human review, not certification of anatomically correct motion.</p>" +
    rows + "</html>";
  await writeFile(testInfo.outputPath("testing-hand-review.html"), reviewHtml, "utf8");

  expect(evidence).toHaveLength(comparedModels.length * comparedTimes.length);
  // Leave the opt-in Testing model selected for the end-of-run diagnostics.
  expect((await browserSnapshot(page))?.handModelDiagnostics?.left.loadedModel).toBe(comparedModel);
});
}
