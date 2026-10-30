import type { PianistProfile } from "@handthesia/contracts";
import { DEFAULT_PROFILE } from "./defaultProfiles";
import { initializeProfiles, listProfiles, saveProfile } from "./profileStore";

/** Saves an editable Default copy without changing which profile is active. */
export async function createTesting2DefaultBaselineProfile(): Promise<PianistProfile> {
  await initializeProfiles();
  const existingProfileIds = new Set(listProfiles().map((profile) => profile.profileId));
  let profileId: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = crypto.randomUUID();
    if (candidate && !existingProfileIds.has(candidate)) {
      profileId = candidate;
      break;
    }
  }
  if (!profileId) throw new Error("Could not generate a unique profile ID. Try again.");
  const now = Date.now() / 1000;
  const baseline = structuredClone(DEFAULT_PROFILE);
  baseline.profileId = profileId;
  baseline.name = "Testing2 — Default baseline";
  baseline.revision = 0;
  baseline.createdAtUnixSeconds = now;
  baseline.modifiedAtUnixSeconds = now;
  // Check collisions visible in this store; IndexedDB writes are not atomic create-if-absent.
  if (listProfiles().some((profile) => profile.profileId === profileId)) {
    throw new Error("A profile with the generated ID already exists. Try again.");
  }
  return saveProfile(baseline);
}
