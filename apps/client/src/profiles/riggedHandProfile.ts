import type { PianistProfile } from "@handthesia/contracts";
import { getDefaultProfile } from "./defaultProfiles.ts";
import { initializeProfiles, listProfiles, saveProfile } from "./profileStore.ts";
import {
  buildRiggedHandProfileFromBase,
  RIGGED_HAND_MEASURED_BASELINE_PROFILE_NAME,
} from "./riggedHandProfileCalibration.ts";

export { RIGGED_HAND_PROFILE_PROVENANCE } from "./riggedHandProfileCalibration.ts";

/**
 * Creates an editable, independent copy of the source-rig baseline.
 * The canonical built-in is provided by defaultProfiles and is never saved here.
 */
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

  const now = Date.now() / 1000;
  const profile = buildRiggedHandProfileFromBase(getDefaultProfile(), {
    profileId,
    name: RIGGED_HAND_MEASURED_BASELINE_PROFILE_NAME,
    revision: 0,
    createdAtUnixSeconds: now,
    modifiedAtUnixSeconds: now,
  });

  // Store writes are not atomic create-if-absent; refuse even an extraordinarily unlikely collision.
  if (listProfiles().some((existing) => existing.profileId === profileId)) {
    throw new Error("A profile with the generated rigged-hand ID already exists. Try again.");
  }
  return saveProfile(profile);
}
