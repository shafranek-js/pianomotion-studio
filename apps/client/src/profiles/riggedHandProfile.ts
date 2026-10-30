import { hands } from "@handthesia/engine-ts";
import type { PianistProfile } from "@handthesia/contracts";
import { getDefaultProfile } from "./defaultProfiles.ts";
import { initializeProfiles, listProfiles, saveProfile } from "./profileStore.ts";
import { ANATOMY_BONES } from "./types.ts";

type Side = "left" | "right";

const SOURCE_SCALE: Readonly<Record<Side, number>> = Object.freeze({
  left: 0.219315506,
  right: 0.219315291,
});
const METERS_TO_INCHES = 1 / 0.0254;

/**
 * Original bone.length values from scratch/testing2-candidate/source-inventory.json.
 * The left/right bone names follow tools/testing2-candidate/bone-map.json.
 */
const SOURCE_SEGMENTS = [
  { anatomyKey: "pp2", finger: "index", segment: "proximal phalanx", bone: "Bone", leftMeters: 0.126316205, rightMeters: 0.126316205 },
  { anatomyKey: "mp2", finger: "index", segment: "middle phalanx", bone: "Bone.001", leftMeters: 0.101073019, rightMeters: 0.10107296 },
  { anatomyKey: "dp2", finger: "index", segment: "distal phalanx", bone: "Bone.002", leftMeters: 0.089823738, rightMeters: 0.089823693 },
  { anatomyKey: "pp3", finger: "middle", segment: "proximal phalanx", bone: "Bone.003", leftMeters: 0.150423855, rightMeters: 0.15042384 },
  { anatomyKey: "mp3", finger: "middle", segment: "middle phalanx", bone: "Bone.004", leftMeters: 0.112109311, rightMeters: 0.112109311 },
  { anatomyKey: "dp3", finger: "middle", segment: "distal phalanx", bone: "Bone.005", leftMeters: 0.093916826, rightMeters: 0.093916826 },
  { anatomyKey: "pp4", finger: "ring", segment: "proximal phalanx", bone: "Bone.006", leftMeters: 0.130892813, rightMeters: 0.130892813 },
  { anatomyKey: "mp4", finger: "ring", segment: "middle phalanx", bone: "Bone.007", leftMeters: 0.104668319, rightMeters: 0.104668438 },
  { anatomyKey: "dp4", finger: "ring", segment: "distal phalanx", bone: "Bone.008", leftMeters: 0.095293611, rightMeters: 0.0952935 },
  { anatomyKey: "pp5", finger: "little", segment: "proximal phalanx", bone: "Bone.009", leftMeters: 0.126155809, rightMeters: 0.126155809 },
  { anatomyKey: "mp5", finger: "little", segment: "middle phalanx", bone: "Bone.010", leftMeters: 0.073296927, rightMeters: 0.073296927 },
  { anatomyKey: "dp5", finger: "little", segment: "distal phalanx", bone: "Bone.011", leftMeters: 0.073491417, rightMeters: 0.073491365 },
] as const;

function toProfileUnits(sourceMeters: number, side: Side): number {
  return sourceMeters * SOURCE_SCALE[side] * METERS_TO_INCHES / hands.INCHES_PER_UNIT;
}

function describeMeasurements() {
  return SOURCE_SEGMENTS.map((source) => {
    const definition = ANATOMY_BONES.find((bone) => bone.id === source.anatomyKey)!;
    const leftProfileUnits = toProfileUnits(source.leftMeters, "left");
    const rightProfileUnits = toProfileUnits(source.rightMeters, "right");
    const meanProfileUnits = (leftProfileUnits + rightProfileUnits) / 2;
    const inEditorRange = Number.isFinite(meanProfileUnits) &&
      meanProfileUnits >= definition.min && meanProfileUnits <= definition.max;
    return Object.freeze({
      ...source,
      sourceLengthUnit: "meters" as const,
      meanSourceMeters: (source.leftMeters + source.rightMeters) / 2,
      leftProfileUnits,
      rightProfileUnits,
      meanProfileUnits,
      profileUnit: "HandGeometry units" as const,
      editableRange: Object.freeze({ min: definition.min, max: definition.max }),
      appliedToProfile: inEditorRange,
      fallbackReason: inEditorRange
        ? null
        : `Converted mean ${meanProfileUnits} HandGeometry units is outside the editor range [${definition.min}, ${definition.max}]; Default ${definition.defaultLength} is retained without clamping.`,
    });
  });
}

const MEASUREMENTS = describeMeasurements();

/** Evidence and exclusions for this experimental, independently saved profile. */
export const RIGGED_HAND_PROFILE_PROVENANCE = Object.freeze({
  source: Object.freeze({
    inventory: "scratch/testing2-candidate/source-inventory.json",
    originalBlendSha256: "6cca25beb3f48460f977f1e47f76612eb87900b64b71cc8b4627d52e54561f40",
    glbSha256: Object.freeze({
      left: "7ce76e5d5f6279d0ac63fe07da062e040ad018670ba827381735b7c18f832dfe",
      right: "1ca11afc819b6811e1dc0ac8b4984fca17aa9408d3ed25a5910309f41a2a3881",
    }),
    boneMap: "tools/testing2-candidate/bone-map.json",
  }),
  conversion: Object.freeze({
    sourceLengthUnit: "meters",
    sourceScale: SOURCE_SCALE,
    metersToInches: METERS_TO_INCHES,
    inchesPerProfileUnit: hands.INCHES_PER_UNIT,
    profileUnit: "HandGeometry units",
    formula: "source bone.length (m) × side SOURCE_SCALE × 39.37007874015748 in/m ÷ hands.INCHES_PER_UNIT",
  }),
  measurements: MEASUREMENTS,
  retainedDefault: Object.freeze([
    { anatomyKey: "mc1", reason: "Thumb/metacarpal root mapping is not validated against HandGeometry." },
    { anatomyKey: "pp1", reason: "Thumb joints use CMC/MCP/IP segments; skin-weight boundary and segment mapping remain ambiguous." },
    { anatomyKey: "dp1", reason: "The source thumb has two distal segments (Bone.018 and Bone.019); the engine has one distal phalanx, and the split is not validated." },
    { anatomyKey: "mc2-mc5", reason: "Source metacarpal roots differ from the fixed HandGeometry roots; their segment lengths are not registered profile offsets." },
    { anatomyKey: "wrist", reason: "The source inventory does not provide a validated wrist-width measure corresponding to this profile field." },
    { anatomyKey: "behavior", reason: "No motion or technique measurements are supplied by the rest-pose rig." },
  ]),
});

/** Creates a deep Default copy with only in-range measured long-finger phalanges changed. */
export async function createRiggedHandProfile(): Promise<PianistProfile> {
  await initializeProfiles();
  const existingIds = new Set(listProfiles().map((profile) => profile.profileId));
  let profileId: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = crypto.randomUUID();
    if (candidate && !existingIds.has(candidate)) {
      profileId = candidate;
      break;
    }
  }
  if (!profileId) throw new Error("Could not generate a unique rigged-hand profile ID. Try again.");

  const profile = getDefaultProfile();
  profile.profileId = profileId;
  profile.name = "Rigged hands — measured baseline";
  profile.revision = 0;
  const now = Date.now() / 1000;
  profile.createdAtUnixSeconds = now;
  profile.modifiedAtUnixSeconds = now;

  for (const measurement of MEASUREMENTS) {
    if (measurement.appliedToProfile) {
      profile.anatomy[measurement.anatomyKey] = measurement.meanProfileUnits;
    }
    // An out-of-range result deliberately leaves the deep-copied Default value untouched.
    // Its explicit fallbackReason is retained in RIGGED_HAND_PROFILE_PROVENANCE.
  }

  // Store writes are not atomic create-if-absent; refuse even an extraordinarily unlikely collision.
  if (listProfiles().some((existing) => existing.profileId === profileId)) {
    throw new Error("A profile with the generated rigged-hand ID already exists. Try again.");
  }
  return saveProfile(profile);
}
