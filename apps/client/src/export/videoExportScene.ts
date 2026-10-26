import type { M1KeyStyle } from "@handthesia/contracts";
import { PianoScene } from "../render";
import type { MotionBuffer } from "../render/motionBuffer";
import { PianoScene3D } from "../render3d";
import { materializeImprovedHandExportDocument } from "./improvedHandExportDocument";
import type { FrozenVideoExportSnapshot } from "./videoExportSnapshot";

export interface VideoFrameScene {
  renderAt(songTime: number): void;
  destroy(): void;
}

/** Owns an isolated, fixed-size renderer. The live scene never supplies video pixels. */
export async function createVideoFrameScene(
  canvas: HTMLCanvasElement,
  snapshot: FrozenVideoExportSnapshot,
  motionBuffer: MotionBuffer,
  keyStyle: M1KeyStyle,
): Promise<VideoFrameScene> {
  const fixedViewport = { width: canvas.width, height: canvas.height, resolution: 1 as const };
  const displaySettings = {
    stageAppearance: snapshot.settings.stageAppearance,
    showFingerLabels: snapshot.settings.showFingerLabels,
    showNoteNames: snapshot.settings.showNoteNames,
    skinStyle: snapshot.settings.skinStyle,
    showHandShadow: snapshot.settings.showHandShadow,
    renderCapFps: 0,
    handModel: snapshot.settings.handModel,
  };
  const sceneDocument = snapshot.settings.handModel === "anatomical-improved"
    ? materializeImprovedHandExportDocument(snapshot.document, snapshot.sourceIdentity.fingeringPlan)
    : snapshot.document;
  if (snapshot.sceneView.dimension === "3d") {
    const scene = new PianoScene3D(canvas, {
      canvas,
      fixedViewport,
      initialHandModel: snapshot.settings.handModel,
    });
    try {
      scene.setNotes(sceneDocument.notes);
      scene.setMotionPlan(snapshot.motionPlan ?? null);
      scene.setMotionBuffer(motionBuffer);
      scene.setPerformancePlan(snapshot.performancePlan);
      scene.setDisplaySettings(displaySettings);
      scene.setPixelsPerSecond(180);
      scene.setCameraPreset(snapshot.sceneView.cameraPreset);
      await scene.waitForHandModelReady?.();
    } catch (error) {
      scene.destroy();
      throw error;
    }
    return { renderAt: (time) => scene.update(time), destroy: () => scene.destroy() };
  }
  const scene = await PianoScene.create({
    target: canvas, fixedViewport, song: sceneDocument,
    performancePlan: snapshot.performancePlan, motionPlan: snapshot.motionPlan ?? null,
    motionBuffer, keyStyle, displaySettings, pixelsPerSecond: 180,
  });
  try {
    await scene.waitForHandModelReady?.();
  } catch (error) {
    scene.destroy();
    throw error;
  }
  return {
    renderAt(time) {
      scene.update(time);
      scene.getApp().renderer.render(scene.getApp().stage);
    },
    destroy: () => scene.destroy(),
  };
}
