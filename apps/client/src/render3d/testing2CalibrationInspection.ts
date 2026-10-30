import {
  improvedHandAssetLoader,
  type ImprovedHandAssetLoader,
} from "./improvedHandAssets";
import {
  calibrateTesting2Profile,
  type Testing2CalibrationReport,
} from "./testing2ProfileCalibration";

export interface Testing2PairedCalibrationInspection {
  left: Testing2CalibrationReport;
  right: Testing2CalibrationReport;
}

/** Explicitly loads both improved hand LOD 0 assets and reports their estimates. */
export async function inspectTesting2Measurements(
  loader: Pick<ImprovedHandAssetLoader, "load"> = improvedHandAssetLoader,
): Promise<Testing2PairedCalibrationInspection> {
  const [leftAsset, rightAsset] = await Promise.all([
    loader.load("left", 0),
    loader.load("right", 0),
  ]);

  if (!leftAsset.lod.landmarks) {
    throw new Error("The improved left-hand LOD has no named calibration landmarks.");
  }
  if (!rightAsset.lod.landmarks) {
    throw new Error("The improved right-hand LOD has no named calibration landmarks.");
  }

  return {
    left: calibrateTesting2Profile("left", leftAsset.lod.landmarks).report,
    right: calibrateTesting2Profile("right", rightAsset.lod.landmarks).report,
  };
}
