import { hands } from "@handthesia/engine-ts";
import { DEFAULT_PROFILE } from "../profiles/defaultProfiles";
import {
  ANATOMY_BONES,
  PianistProfileSchema,
  type PianistProfile,
} from "../profiles/types";

export type Testing2CalibrationHand = "left" | "right";

/**
 * Positions are the 25 named landmarks emitted with the improved hand GLBs.
 * Their coordinates use the asset's meter coordinate frame. The raw source
 * mesh did not contain an authored rig: these joint positions are estimates
 * made for the improved rig, not verified anatomical measurements.
 */
export const TESTING2_SOURCE_LANDMARK_NAMES = [
  "pinky-finger-tip",
  "pinky-finger-phalanx-distal",
  "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-proximal",
  "pinky-finger-metacarpal",
  "ring-finger-tip",
  "ring-finger-phalanx-distal",
  "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-proximal",
  "ring-finger-metacarpal",
  "middle-finger-tip",
  "middle-finger-phalanx-distal",
  "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-proximal",
  "middle-finger-metacarpal",
  "index-finger-tip",
  "index-finger-phalanx-distal",
  "index-finger-phalanx-intermediate",
  "index-finger-phalanx-proximal",
  "index-finger-metacarpal",
  "thumb-tip",
  "thumb-phalanx-distal",
  "thumb-phalanx-proximal",
  "thumb-metacarpal",
  "wrist",
] as const;

export type Testing2SourceLandmarkName = typeof TESTING2_SOURCE_LANDMARK_NAMES[number];
export type Testing2SourceHandPositions = Readonly<Record<
  Testing2SourceLandmarkName,
  readonly [number, number, number]
>>;

type SegmentDefinition = {
  profileKey: keyof PianistProfile["anatomy"];
  finger: 1 | 2 | 3 | 4 | 5;
  segment: "metacarpal" | "proximal phalanx" | "middle phalanx" | "distal phalanx";
  startLandmark: Testing2SourceLandmarkName;
  endLandmark: Testing2SourceLandmarkName;
};

const SEGMENTS: readonly SegmentDefinition[] = [
  { profileKey: "mc1", finger: 1, segment: "metacarpal", startLandmark: "thumb-metacarpal", endLandmark: "thumb-phalanx-proximal" },
  { profileKey: "pp1", finger: 1, segment: "proximal phalanx", startLandmark: "thumb-phalanx-proximal", endLandmark: "thumb-phalanx-distal" },
  { profileKey: "dp1", finger: 1, segment: "distal phalanx", startLandmark: "thumb-phalanx-distal", endLandmark: "thumb-tip" },
  { profileKey: "mc2", finger: 2, segment: "metacarpal", startLandmark: "index-finger-metacarpal", endLandmark: "index-finger-phalanx-proximal" },
  { profileKey: "pp2", finger: 2, segment: "proximal phalanx", startLandmark: "index-finger-phalanx-proximal", endLandmark: "index-finger-phalanx-intermediate" },
  { profileKey: "mp2", finger: 2, segment: "middle phalanx", startLandmark: "index-finger-phalanx-intermediate", endLandmark: "index-finger-phalanx-distal" },
  { profileKey: "dp2", finger: 2, segment: "distal phalanx", startLandmark: "index-finger-phalanx-distal", endLandmark: "index-finger-tip" },
  { profileKey: "mc3", finger: 3, segment: "metacarpal", startLandmark: "middle-finger-metacarpal", endLandmark: "middle-finger-phalanx-proximal" },
  { profileKey: "pp3", finger: 3, segment: "proximal phalanx", startLandmark: "middle-finger-phalanx-proximal", endLandmark: "middle-finger-phalanx-intermediate" },
  { profileKey: "mp3", finger: 3, segment: "middle phalanx", startLandmark: "middle-finger-phalanx-intermediate", endLandmark: "middle-finger-phalanx-distal" },
  { profileKey: "dp3", finger: 3, segment: "distal phalanx", startLandmark: "middle-finger-phalanx-distal", endLandmark: "middle-finger-tip" },
  { profileKey: "mc4", finger: 4, segment: "metacarpal", startLandmark: "ring-finger-metacarpal", endLandmark: "ring-finger-phalanx-proximal" },
  { profileKey: "pp4", finger: 4, segment: "proximal phalanx", startLandmark: "ring-finger-phalanx-proximal", endLandmark: "ring-finger-phalanx-intermediate" },
  { profileKey: "mp4", finger: 4, segment: "middle phalanx", startLandmark: "ring-finger-phalanx-intermediate", endLandmark: "ring-finger-phalanx-distal" },
  { profileKey: "dp4", finger: 4, segment: "distal phalanx", startLandmark: "ring-finger-phalanx-distal", endLandmark: "ring-finger-tip" },
  { profileKey: "mc5", finger: 5, segment: "metacarpal", startLandmark: "pinky-finger-metacarpal", endLandmark: "pinky-finger-phalanx-proximal" },
  { profileKey: "pp5", finger: 5, segment: "proximal phalanx", startLandmark: "pinky-finger-phalanx-proximal", endLandmark: "pinky-finger-phalanx-intermediate" },
  { profileKey: "mp5", finger: 5, segment: "middle phalanx", startLandmark: "pinky-finger-phalanx-intermediate", endLandmark: "pinky-finger-phalanx-distal" },
  { profileKey: "dp5", finger: 5, segment: "distal phalanx", startLandmark: "pinky-finger-phalanx-distal", endLandmark: "pinky-finger-tip" },
] as const;

export type Testing2CalibrationDiagnosticCode =
  | "missing-landmark"
  | "invalid-landmark-position"
  | "unexpected-landmark"
  | "zero-length-segment"
  | "segment-outside-editor-range"
  | "estimated-segment-not-applied"
  | "metacarpal-length-reference-only"
  | "palm-width-not-independently-representable"
  | "wrist-width-unavailable"
  | "metacarpal-root-geometry-not-representable"
  | "invalid-profile-options"
  | "profile-schema-rejected";

export interface Testing2CalibrationDiagnostic {
  severity: "info" | "warning" | "error";
  code: Testing2CalibrationDiagnosticCode;
  message: string;
  path?: string;
}

export interface Testing2SegmentMeasurement {
  profileKey: SegmentDefinition["profileKey"];
  finger: SegmentDefinition["finger"];
  segment: SegmentDefinition["segment"];
  startLandmark: Testing2SourceLandmarkName;
  endLandmark: Testing2SourceLandmarkName;
  status: "measured" | "unavailable";
  mappingStatus?: "reference-only-estimated-anatomy" | "reference-only-unregistered-metacarpal-root";
  appliedToProfile?: false;
  unavailableReason?: "missing-landmark" | "invalid-landmark-position" | "zero-length-segment";
  distanceMeters?: number;
  distanceMillimeters?: number;
  distanceInches?: number;
  convertedLengthProfileModelUnits?: number;
  candidateProfileModelUnits?: number;
  defaultProfileModelUnits?: number;
  differenceFromDefaultProfileModelUnits?: number;
  ratioToDefault?: number;
  editableRange?: { minProfileModelUnits: number; maxProfileModelUnits: number; inRange: boolean };
}

export interface Testing2CalibrationReport {
  hand: Testing2CalibrationHand;
  provenance: {
    coordinateUnit: "meters";
    coordinateFrame: "improved GLB estimated bind/rest frame; right-handed; distances are orientation independent";
    rawSourceRigPresent: false;
    improvedRigPositionsAreEstimated: true;
    anatomicalTruthVerified: false;
    note: string;
  };
  conversion: {
    sourceMetersPerUnit: 1;
    millimetersPerMeter: 1000;
    millimetersPerInch: 25.4;
    engineInchesPerProfileModelUnit: number;
    millimetersPerProfileModelUnit: number;
    profileModelUnitDescription: "HandGeometry anatomy unit";
  };
  landmarks: {
    requiredCount: 25;
    validCount: number;
    missing: Testing2SourceLandmarkName[];
    invalid: Testing2SourceLandmarkName[];
    unexpected: string[];
  };
  measurements: Testing2SegmentMeasurement[];
  geometry: {
    palmMcpSpan?: { startLandmark: string; endLandmark: string; millimeters: number; inches: number };
    metacarpalBaseSpan?: { startLandmark: string; endLandmark: string; millimeters: number; inches: number };
    metacarpalRootPositions?: Partial<Record<Testing2SourceLandmarkName, { meters: [number, number, number]; millimeters: [number, number, number] }>>;
    wristWidth: null;
    wristProfileScaleRetainedFromDefault: number;
    independentlyRepresentablePalmWidth: false;
    independentlyRepresentableMetacarpalRootPositions: false;
  };
  diagnostics: Testing2CalibrationDiagnostic[];
  comparison: {
    referenceProfileId: "default";
    purpose: "scale comparison only; not confirmation of anatomical accuracy";
  };
  anatomyPolicy: "Default anatomy retained; unverified source estimates are report-only suggestions";
  profileDtoCreated: boolean;
  persistence: "proposed-only; not saved or selected";
}

export interface Testing2ProfileCalibrationOptions {
  /** Set this when the caller needs a known profile-store-safe identifier. */
  profileId?: string;
  name?: string;
  /** Injectable for deterministic import/export workflows; defaults to current time. */
  createdAtUnixSeconds?: number;
}

export interface Testing2ProfileCalibrationResult {
  /** Null when required measurements or options are invalid; nothing is persisted. */
  profile: PianistProfile | null;
  report: Testing2CalibrationReport;
}

const MILLIMETERS_PER_INCH = 25.4;
const MILLIMETERS_PER_METER = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPoint3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component));
}

function distanceMeters(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function makeProfileId(hand: Testing2CalibrationHand): string | null {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `testing2-source-${hand}-${globalThis.crypto.randomUUID()}`;
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const token = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `testing2-source-${hand}-${token}`;
  }
  return null;
}

function calibratedSpan(
  positions: Partial<Record<Testing2SourceLandmarkName, [number, number, number]>>,
  startLandmark: Testing2SourceLandmarkName,
  endLandmark: Testing2SourceLandmarkName,
): { startLandmark: string; endLandmark: string; millimeters: number; inches: number } | undefined {
  const start = positions[startLandmark];
  const end = positions[endLandmark];
  if (!start || !end) return undefined;
  const millimeters = distanceMeters(start, end) * MILLIMETERS_PER_METER;
  return { startLandmark, endLandmark, millimeters, inches: millimeters / MILLIMETERS_PER_INCH };
}

/**
 * Measures the supplied left OR right estimated source landmarks and returns
 * a fresh profile copied from Default. Until the source-to-engine registration
 * is verified, every anatomy measurement remains a report-only suggestion.
 * This function never changes, saves, or selects an existing profile.
 */
export function calibrateTesting2Profile(
  hand: Testing2CalibrationHand,
  sourcePositions: unknown,
  options: Testing2ProfileCalibrationOptions = {},
): Testing2ProfileCalibrationResult {
  const diagnostics: Testing2CalibrationDiagnostic[] = [
    {
      severity: "warning",
      code: "palm-width-not-independently-representable",
      message: "The measured palm span is reported for review; HandGeometry has no independent palm-width anatomy field.",
    },
    {
      severity: "warning",
      code: "wrist-width-unavailable",
      message: "Only one wrist landmark is supplied, so wrist width cannot be measured. The Default wrist scale is retained without calibration.",
      path: "anatomy.wrist",
    },
    {
      severity: "warning",
      code: "metacarpal-root-geometry-not-representable",
      message: "The five source metacarpal root positions are reported but cannot be represented as independent root offsets in HandGeometry.",
    },
  ];
  const inchesPerProfileUnit = hands.INCHES_PER_UNIT;
  const validConversion = typeof inchesPerProfileUnit === "number" &&
    Number.isFinite(inchesPerProfileUnit) && inchesPerProfileUnit > 0;
  const millimetersPerProfileUnit = validConversion ? inchesPerProfileUnit * MILLIMETERS_PER_INCH : Number.NaN;
  const validPositions: Partial<Record<Testing2SourceLandmarkName, [number, number, number]>> = {};
  const missing: Testing2SourceLandmarkName[] = [];
  const invalid: Testing2SourceLandmarkName[] = [];
  const unexpected: string[] = [];

  if (!isRecord(sourcePositions)) {
    for (const name of TESTING2_SOURCE_LANDMARK_NAMES) missing.push(name);
    diagnostics.push({
      severity: "error",
      code: "invalid-landmark-position",
      message: "Source landmarks must be a named object containing all 25 finite 3D points in meters.",
      path: "landmarks",
    });
  } else {
    for (const name of TESTING2_SOURCE_LANDMARK_NAMES) {
      const value = sourcePositions[name];
      if (value === undefined || value === null) {
        missing.push(name);
        diagnostics.push({ severity: "error", code: "missing-landmark", message: `Required source landmark '${name}' is missing.`, path: `landmarks.${name}` });
      } else if (!isPoint3(value)) {
        invalid.push(name);
        diagnostics.push({ severity: "error", code: "invalid-landmark-position", message: `Source landmark '${name}' must be a finite [x, y, z] coordinate in meters.`, path: `landmarks.${name}` });
      } else {
        validPositions[name] = [...value];
      }
    }
    const requiredNames = new Set<string>(TESTING2_SOURCE_LANDMARK_NAMES);
    unexpected.push(...Object.keys(sourcePositions).filter((name) => !requiredNames.has(name)));
    if (unexpected.length > 0) {
      diagnostics.push({ severity: "warning", code: "unexpected-landmark", message: `Ignored ${unexpected.length} unrecognized landmark(s): ${unexpected.join(", ")}.`, path: "landmarks" });
    }
  }

  if (!validConversion) {
    diagnostics.push({ severity: "error", code: "invalid-profile-options", message: "The engine's inches-per-profile-unit conversion is not a positive finite number.", path: "conversion" });
  }

  const measurements: Testing2SegmentMeasurement[] = SEGMENTS.map((segment) => {
    const start = validPositions[segment.startLandmark];
    const end = validPositions[segment.endLandmark];
    const base: Testing2SegmentMeasurement = {
      profileKey: segment.profileKey,
      finger: segment.finger,
      segment: segment.segment,
      startLandmark: segment.startLandmark,
      endLandmark: segment.endLandmark,
      status: "unavailable",
    };
    if (!start || !end) {
      const badLandmark = invalid.includes(segment.startLandmark) || invalid.includes(segment.endLandmark);
      base.unavailableReason = badLandmark ? "invalid-landmark-position" : "missing-landmark";
      return base;
    }
    const meters = distanceMeters(start, end);
    if (!Number.isFinite(meters) || meters <= 0) {
      base.unavailableReason = "zero-length-segment";
      diagnostics.push({
        severity: "error",
        code: "zero-length-segment",
        message: `The ${segment.profileKey} segment has zero or invalid length; no fallback or clamp was applied.`,
        path: `measurements.${segment.profileKey}`,
      });
      return base;
    }
    const millimeters = meters * MILLIMETERS_PER_METER;
    const inches = millimeters / MILLIMETERS_PER_INCH;
    const profileModelUnits = validConversion ? inches / inchesPerProfileUnit : Number.NaN;
    const definition = ANATOMY_BONES.find((bone) => bone.id === segment.profileKey);
    const defaultValue = DEFAULT_PROFILE.anatomy[segment.profileKey];
    const isMetacarpal = segment.segment === "metacarpal";
    const inEditorRange = Boolean(definition && profileModelUnits >= definition.min && profileModelUnits <= definition.max);
    const result: Testing2SegmentMeasurement = {
      ...base,
      status: "measured",
      distanceMeters: meters,
      distanceMillimeters: millimeters,
      distanceInches: inches,
      convertedLengthProfileModelUnits: profileModelUnits,
      mappingStatus: isMetacarpal ? "reference-only-unregistered-metacarpal-root" : "reference-only-estimated-anatomy",
      appliedToProfile: false,
      candidateProfileModelUnits: profileModelUnits,
      defaultProfileModelUnits: defaultValue,
      differenceFromDefaultProfileModelUnits: profileModelUnits - defaultValue,
      ratioToDefault: profileModelUnits / defaultValue,
      editableRange: definition
        ? { minProfileModelUnits: definition.min, maxProfileModelUnits: definition.max, inRange: inEditorRange }
        : undefined,
    };
    if (!inEditorRange) {
      diagnostics.push({
        severity: "warning",
        code: "segment-outside-editor-range",
        message: isMetacarpal
          ? `${segment.profileKey} converts to ${profileModelUnits} HandGeometry units, outside its profile editor range; the exact measurement remains report-only because its root is unregistered.`
          : `${segment.profileKey} converts to ${profileModelUnits} HandGeometry units, outside its profile editor range; Default remains in the proposed profile, and this estimate is reported without clamping.`,
        path: `anatomy.${segment.profileKey}`,
      });
    }
    diagnostics.push({
      severity: "warning",
      code: "estimated-segment-not-applied",
      message: `${segment.profileKey} is derived from unverified estimated joint positions. It is a comparison suggestion only; Default anatomy is retained until source-to-engine registration is verified.`,
      path: `anatomy.${segment.profileKey}`,
    });
    if (isMetacarpal) {
      diagnostics.push({
        severity: "warning",
        code: "metacarpal-length-reference-only",
        message: `${segment.profileKey} is a measured landmark-to-landmark distance only. The estimated source metacarpal root is not registered to HandGeometry's fixed root, so this value is excluded from the proposed anatomy and Default is retained.`,
        path: `anatomy.${segment.profileKey}`,
      });
    }
    return result;
  });

  const rootNames = [
    "thumb-metacarpal",
    "index-finger-metacarpal",
    "middle-finger-metacarpal",
    "ring-finger-metacarpal",
    "pinky-finger-metacarpal",
  ] as const;
  const metacarpalRootPositions: Testing2CalibrationReport["geometry"]["metacarpalRootPositions"] = {};
  for (const name of rootNames) {
    const point = validPositions[name];
    if (point) {
      metacarpalRootPositions[name] = {
        meters: [...point],
        millimeters: point.map((component) => component * MILLIMETERS_PER_METER) as [number, number, number],
      };
    }
  }

  const palmMcpSpan = calibratedSpan(validPositions, "index-finger-phalanx-proximal", "pinky-finger-phalanx-proximal");
  const metacarpalBaseSpan = calibratedSpan(validPositions, "index-finger-metacarpal", "pinky-finger-metacarpal");
  const report: Testing2CalibrationReport = {
    hand,
    provenance: {
      coordinateUnit: "meters",
      coordinateFrame: "improved GLB estimated bind/rest frame; right-handed; distances are orientation independent",
      rawSourceRigPresent: false,
      improvedRigPositionsAreEstimated: true,
      anatomicalTruthVerified: false,
      note: "These positions are estimates in the improved GLB bind/rest frame. The raw source mesh has no rig, and the positions have not been established as anatomical ground truth.",
    },
    conversion: {
      sourceMetersPerUnit: 1,
      millimetersPerMeter: MILLIMETERS_PER_METER,
      millimetersPerInch: MILLIMETERS_PER_INCH,
      engineInchesPerProfileModelUnit: inchesPerProfileUnit,
      millimetersPerProfileModelUnit: millimetersPerProfileUnit,
      profileModelUnitDescription: "HandGeometry anatomy unit",
    },
    landmarks: {
      requiredCount: TESTING2_SOURCE_LANDMARK_NAMES.length,
      validCount: Object.keys(validPositions).length,
      missing,
      invalid,
      unexpected,
    },
    measurements,
    geometry: {
      palmMcpSpan,
      metacarpalBaseSpan,
      metacarpalRootPositions,
      wristWidth: null,
      wristProfileScaleRetainedFromDefault: DEFAULT_PROFILE.anatomy.wrist,
      independentlyRepresentablePalmWidth: false,
      independentlyRepresentableMetacarpalRootPositions: false,
    },
    diagnostics,
    comparison: {
      referenceProfileId: "default",
      purpose: "scale comparison only; not confirmation of anatomical accuracy",
    },
    anatomyPolicy: "Default anatomy retained; unverified source estimates are report-only suggestions",
    profileDtoCreated: false,
    persistence: "proposed-only; not saved or selected",
  };

  const inputHasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const measuredSegments = measurements.filter((measurement) => measurement.status === "measured");
  const allSegmentsMeasured = measuredSegments.length === SEGMENTS.length &&
    measuredSegments.every((measurement) => Number.isFinite(measurement.convertedLengthProfileModelUnits) && measurement.convertedLengthProfileModelUnits! > 0);
  if (inputHasErrors || !allSegmentsMeasured) return { profile: null, report };

  const timestamp = options.createdAtUnixSeconds ?? Date.now() / 1000;
  const profileId = options.profileId ?? makeProfileId(hand);
  const name = options.name ?? `Testing2 source calibration (${hand})`;
  if (typeof profileId !== "string" || !profileId.trim() || profileId.trim() === DEFAULT_PROFILE.profileId || profileId.length > 200 ||
      typeof name !== "string" || !name.trim() ||
      typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
    diagnostics.push({ severity: "error", code: "invalid-profile-options", message: "Profile name, ID, or creation time is invalid. A cryptographic random ID must be available when profileId is omitted, and the proposed ID must differ from Default.", path: "profile" });
    return { profile: null, report };
  }

  const anatomy = { ...DEFAULT_PROFILE.anatomy };

  try {
    const profile = PianistProfileSchema.parse({
      ...structuredClone(DEFAULT_PROFILE),
      profileId: profileId.trim(),
      revision: 0,
      name: name.trim(),
      anatomy,
      createdAtUnixSeconds: timestamp,
      modifiedAtUnixSeconds: timestamp,
    });
    report.profileDtoCreated = true;
    return { profile, report };
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "profile-schema-rejected",
      message: `The proposed new profile did not pass PianistProfileSchema: ${error instanceof Error ? error.message : String(error)}`,
      path: "profile",
    });
    return { profile: null, report };
  }
}
