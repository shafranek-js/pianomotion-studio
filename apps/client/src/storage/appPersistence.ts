import { getActiveProfile, initializeProfiles } from "../profiles/profileStore.ts";
import { initializeSettings } from "../settings/settingsStore.ts";
import { openProjectDb } from "./projectDb.ts";

export interface AppPersistenceState {
  activeProfileId: string;
}

/** Opens and migrates browser persistence before the application reads profile or settings state. */
export async function initializeAppPersistence(): Promise<AppPersistenceState> {
  await openProjectDb();
  await initializeProfiles();
  await initializeSettings();
  return { activeProfileId: getActiveProfile().profileId };
}
