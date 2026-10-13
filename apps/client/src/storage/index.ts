/**
 * Storage and Project Persistence Module.
 *
 * Implements:
 * - Native IndexedDB persistence layer for projects, profiles, settings, and autosave sessions.
 * - Profile persistence (custom PianistProfile records).
 * - Debounced autosave session snapshots and recovery.
 * - Storage quota diagnostics and QuotaExceededError handling safety.
 * - Recent projects tracking (last 5 opened) in localStorage / memory.
 * - Project package export and import.
 * - MIDI file validation (extension, size <= 16 MiB) for drag-and-drop / file inputs.
 */

export {
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  PROJECTS_STORE,
  PROFILES_STORE,
  SETTINGS_STORE,
  SESSION_STORE,
  StorageQuotaExceededError,
  isQuotaExceededError,
  wrapQuotaError,
  SavedProjectSchema,
  validateSavedProject,
  openProjectDb,
  closeProjectDb,
  setIndexedDBFactory,
  saveProject,
  getProject,
  listProjects,
  deleteProject,
  clearAllProjects,
  saveProfile,
  getProfile,
  listCustomProfiles,
  deleteProfile,
  deleteProfileAndSetActive,
  clearAllProfiles,
  saveDbSetting,
  getDbSetting,
  deleteDbSetting,
  type SavedProject,
  type ProjectSummary,
  type PersistedSettingRecord,
} from "./projectDb.ts";

export { initializeAppPersistence, type AppPersistenceState } from "./appPersistence.ts";

export {
  AUTOSAVE_SESSION_ID,
  saveSessionSnapshot,
  loadSessionSnapshot,
  assessSessionSnapshot,
  clearSessionSnapshot,
  getStorageQuota,
  AutosaveService,
  createAutosaveService,
  type SessionSnapshot,
  type StorageQuotaInfo,
  type AutosaveServiceOptions,
  type SessionSnapshotAssessment,
} from "./autosave.ts";

export {
  RECENT_MAX,
  RECENT_STORAGE_KEY,
  setRecentStorage,
  getRecentProjectIds,
  getRecentProjects,
  saveRecentProjectIds,
  addRecentProjectId,
  addRecentProject,
  removeRecentProjectId,
  removeRecentProject,
  clearRecentProjects,
  getRecentSavedProjects,
} from "./recent.ts";

export {
  computeSha256Hex,
  buildProjectPackage,
  buildProjectPackageSync,
  exportProjectPackageJson,
  downloadFile,
  downloadProjectPackage,
  validateProjectPackage,
  safeValidateProjectPackage,
  parseProjectPackageJson,
  importProjectPackageFile,
  projectPackageToSavedProject,
  importProjectOrPackage,
  assertNoPrototypePollution,
  MAX_PACKAGE_JSON_LENGTH_CHARS,
  type ExportProjectPackageOptions,
} from "./packageExporter.ts";

export {
  MAX_MIDI_FILE_SIZE_BYTES,
  MAX_AUDIO_FILE_SIZE_BYTES,
  MAX_PACKAGE_FILE_SIZE_BYTES,
  ALLOWED_MIDI_EXTENSIONS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_PACKAGE_EXTENSIONS,
  getFileExtension,
  hasMidiExtension,
  hasAudioExtension,
  hasPackageExtension,
  sanitizeFilename,
  isSafeResourcePath,
  validateMidiFile,
  validateMidiFileList,
  validatePackageFile,
  validateAudioRecordingFile,
  isDragEventWithFiles,
  extractMidiFileFromDrop,
  extractAllMidiFilesFromDrop,
  validateMidiFileInput,
  type FileValidationErrorCode,
  type FileValidationSuccess,
  type FileValidationFailure,
  type FileValidationResult,
} from "./fileValidator.ts";
