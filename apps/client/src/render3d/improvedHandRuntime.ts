export const IMPROVED_HAND_MODEL_ID = "anatomical-improved" as const;

export const TESTING_HAND_MODEL_ID = "testing" as const;

export type HandModelId = "anatomical" | "webxr" | typeof IMPROVED_HAND_MODEL_ID | typeof TESTING_HAND_MODEL_ID;

/** Detailed PBR shell models are async-loaded; WebXR and old Anatomical remain unchanged. */
export function isDetailedHandModel(model: HandModelId): model is typeof IMPROVED_HAND_MODEL_ID | typeof TESTING_HAND_MODEL_ID {
  return model === IMPROVED_HAND_MODEL_ID || model === TESTING_HAND_MODEL_ID;
}
export type ImprovedHandLod = 0 | 1 | 2;
export type HandModelLoadState = "idle" | "loading" | "ready" | "error" | "disposed";

export interface HandModelDiagnostics {
  requestedModel: HandModelId;
  loadedModel: HandModelId;
  requestedLod: ImprovedHandLod | null;
  loadedLod: ImprovedHandLod | null;
  state: HandModelLoadState;
  error: string | null;
  triangles: number;
  cachedAssetCount: number;
  cachedGlbAssetCount: number;
  cachedGlbBytes: number;
  cachedTextureCount: number;
  estimatedTextureBaseBytes: number;
  /** Retained GLB bytes plus a decoded RGBA texture base-level estimate. */
  cachedAssetBytes: number;
  /** Score-note finger contacts currently applied to this hand's improved rig. */
  activeContactTargets: Array<{ finger: number; pitch: number }>;
}

export interface HandModelDiagnosticsSnapshot {
  left: HandModelDiagnostics;
  right: HandModelDiagnostics;
  renderer: {
    drawCalls: number;
    triangles: number;
    geometries: number;
    textures: number;
    renderedFramesTotal: number;
    renderedFramesWindow: number;
    renderWindowMs: number;
    handUpdateFramesTotal: number;
    handUpdateFramesWindow: number;
    handUpdateMeanMs: number;
    handUpdateLastMs: number;
  };
}

/**
 * Selects a mesh tier from the hand's projected height. Thresholds intentionally
 * have a dead band so a hand near a boundary does not fetch and replace meshes
 * on every small camera movement.
 */
export function chooseImprovedHandLod(
  projectedHeightPx: number,
  current: ImprovedHandLod | null = null,
): ImprovedHandLod {
  const pixels = Number.isFinite(projectedHeightPx) ? Math.max(0, projectedHeightPx) : Number.POSITIVE_INFINITY;
  if (current === null) {
    return pixels >= 420 ? 0 : pixels >= 170 ? 1 : 2;
  }
  if (current === 0) return pixels < 350 ? 1 : 0;
  if (current === 1) {
    if (pixels >= 490) return 0;
    if (pixels < 140) return 2;
    return 1;
  }
  return pixels >= 200 ? 1 : 2;
}

/** Fixed viewport exports always use the same highest-detail mesh tier. */
export function chooseImprovedHandExportLod(): ImprovedHandLod {
  return 0;
}

/**
 * Invalidates async asset work when a model selection changes or a scene is
 * disposed. A completion may install a rig only while its token is current.
 */
export class HandModelRequestGate {
  private generation = 0;
  private disposed = false;

  public begin(): number {
    if (this.disposed) return -1;
    this.generation += 1;
    return this.generation;
  }

  public isCurrent(token: number): boolean {
    return !this.disposed && token >= 0 && token === this.generation;
  }

  public invalidate(): void {
    if (!this.disposed) this.generation += 1;
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Improved hand assets could not be loaded.";
}
