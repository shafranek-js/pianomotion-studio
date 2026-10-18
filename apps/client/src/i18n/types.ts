import type { AppLanguage } from "../settings/types.ts";

export type { AppLanguage };

export interface CommonTranslations {
  save: string;
  cancel: string;
  close: string;
  closePanel: string;
  delete: string;
  open: string;
  edit: string;
  loading: string;
  error: string;
  ready: string;
  yes: string;
  no: string;
  retry: string;
  search: string;
  reset: string;
  back: string;
  next: string;
  done: string;
  apply: string;
  warning: string;
  success: string;
  info: string;
  actions: string;
  version: string;
  none: string;
  all: string;
  workspacePanel: string;
}

export interface WelcomeTranslations {
  eyebrow: string;
  title: string;
  subtitle: string;
  openMidi: string;
  browseMelodies: string;
  openProject: string;
  playDemo: string;
  recentProjects: string;
  noRecentProjects: string;
  dropPrompt: string;
}

export interface HeaderTranslations {
  file: string;
  edit: string;
  view: string;
  settings: string;
  help: string;
  undo: string;
  redo: string;
  preferences: string;
  pianistProfile: string;
  focusMode: string;
  fullscreen: string;
  exitFullscreen: string;
  inspector: string;
  saveProject: string;
  exportPackage: string;
  exportMidi: string;
  exportVideo: string;
  keyboardShortcuts: string;
  about: string;
  documentation: string;
  openMidi: string;
  openPackage: string;
  builtinMelodies: string;
  projects: string;
  toggleProjects: string;
  toggleInspector: string;
  pinPanel: string;
  unpinPanel: string;
  pinNamedPanel: string;
  unpinNamedPanel: string;
}

export interface ViewsTranslations {
  performance: string;
  pianoRoll: string;
  fingering: string;
  sheet: string;
  split: string;
  view2D: string;
  view3D: string;
  cameraConcert: string;
  cameraPianist: string;
  cameraTopDown: string;
  cameraSide: string;
  followingPlayhead: string;
  returnToPlayhead: string;
}

export interface PlaybackTranslations {
  play: string;
  pause: string;
  stop: string;
  speed: string;
  volume: string;
  metronome: string;
  loop: string;
  loopStart: string;
  loopEnd: string;
  seek: string;
  leadIn: string;
  playAlong: string;
  timeRemaining: string;
  tempo: string;
  mute: string;
  unmute: string;
}

export interface EditorTranslations {
  leftHand: string;
  rightHand: string;
  bothHands: string;
  finger1: string;
  finger2: string;
  finger3: string;
  finger4: string;
  finger5: string;
  clearFinger: string;
  unplayable: string;
  glissando: string;
  recalculate: string;
  autoAdvance: string;
  selectAll: string;
  deselectAll: string;
  handAssignment: string;
  fingerAssignment: string;
  confidence: string;
  cost: string;
  replanning: string;
}

export interface SettingsTranslations {
  title: string;
  general: string;
  visual: string;
  audio: string;
  engine: string;
  storage: string;
  language: string;
  languageEn: string;
  languageCs: string;
  languageUk: string;
  languageDe: string;
  languageEs: string;
  languageIt: string;
  keyStyle: string;
  realisticKeys: string;
  equalKeys: string;
  skinStyle: string;
  skinRealistic: string;
  skinCartoon: string;
  skinGloves: string;
  skinRobot: string;
  skinSkeleton: string;
  showShadow: string;
  showFingerLabels: string;
  showNoteNames: string;
  showFps: string;
  frameCap: string;
  soundOutput: string;
  synth: string;
  soundfont: string;
  webMidi: string;
  timbre: string;
  acoustic: string;
  bright: string;
  warm: string;
  calculationEngine: string;
  pythonEngine: string;
  tsEngine: string;
  storageQuota: string;
  clearCache: string;
  resetDefaults: string;
  uploadSoundfont: string;
  customSoundfonts: string;
  webMidiOutputDevice: string;
  webMidiChannel: string;
}

export interface PianistTranslations {
  title: string;
  subtitle: string;
  presets: string;
  defaultPreset: string;
  smallHandsPreset: string;
  virtuosoPreset: string;
  leftDominantPreset: string;
  customPreset: string;
  handDimensions: string;
  palmWidth: string;
  wristHeight: string;
  fingerLengths: string;
  thumb: string;
  index: string;
  middle: string;
  ring: string;
  pinky: string;
  speed: string;
  flexibility: string;
  duplicate: string;
  delete: string;
  reset: string;
  importProfile: string;
  exportProfile: string;
  profileName: string;
}

export interface ExportTranslations {
  title: string;
  format: string;
  mp4: string;
  webm: string;
  wav: string;
  resolution: string;
  framerate: string;
  quality: string;
  exportButton: string;
  rendering: string;
  cancelling: string;
  cancel: string;
  download: string;
  unavailable: string;
  exportComplete: string;
  estimatedTime: string;
}

export interface MelodiesTranslations {
  title: string;
  searchPlaceholder: string;
  allTags: string;
  difficulty: string;
  composer: string;
  duration: string;
  play: string;
  openMelody: string;
  favourites: string;
  addToFavourites: string;
  removeFromFavourites: string;
  noMelodiesFound: string;
  filterByTag: string;
}

export interface ProjectsTranslations {
  title: string;
  savedInBrowser: string;
  lastModified: string;
  open: string;
  delete: string;
  export: string;
  noProjects: string;
  confirmDelete: string;
  currentProject: string;
}

export interface DiagnosticsTranslations {
  title: string;
  eventLog: string;
  clearLog: string;
  copyLog: string;
  downloadLog: string;
  engineHash: string;
  developerTools: string;
  systemInfo: string;
  activeWorker: string;
  memoryUsage: string;
  logCopied: string;
}

export interface DialogsTranslations {
  unsavedTitle: string;
  unsavedDescription: string;
  saveAndOpen: string;
  discardAndOpen: string;
  legacyTitle: string;
  legacyDescription: string;
  verifyAndOpen: string;
  updateReady: string;
  updateDescription: string;
  reloadNow: string;
  dismiss: string;
}

export interface StageAppearanceTranslations {
  title: string;
  preset: string;
  concert: string;
  studio: string;
  brightness: string;
  reflectionStrength: string;
  quality: string;
  qualityAuto: string;
  qualityLow: string;
  qualityHigh: string;
  storageHint: string;
}

export interface RailTranslations {
  label: string;
  library: string;
  importMidi: string;
  audioRecording: string;
  openAudioRecording: string;
  audioUnavailable: string;
  practice: string;
  openPractice: string;
  practiceUnavailable: string;
  focus: string;
}

export interface PracticeTranslations {
  title: string;
  panelDescription: string;
  loopSection: string;
  loopStart: string;
  loopEnd: string;
  setStartAtPlayhead: string;
  setEndAtPlayhead: string;
  repeatEnabled: string;
  resetRepeat: string;
  invalidLoopRange: string;
  loopPointOutsideDuration: string;
  invalidLoopTime: string;
  loopUnavailable: string;
  secondsUnit: string;
  bookmarkSection: string;
  bookmarkRepeatHint: string;
  bookmarkName: string;
  bookmarkNamePlaceholder: string;
  defaultBookmarkName: string;
  addBookmark: string;
  addBookmarkAtCurrentTime: string;
  noBookmarks: string;
  jumpToBookmark: string;
  renameBookmark: string;
  saveBookmarkName: string;
  cancelRename: string;
  deleteBookmark: string;
  clearBookmarks: string;
  bookmarkNameRequired: string;
  invalidSavedState: string;
  unsavedChanges: string;
}

export interface TranslationDictionary {
  common: CommonTranslations;
  welcome: WelcomeTranslations;
  header: HeaderTranslations;
  views: ViewsTranslations;
  playback: PlaybackTranslations;
  editor: EditorTranslations;
  settings: SettingsTranslations;
  pianist: PianistTranslations;
  export: ExportTranslations;
  melodies: MelodiesTranslations;
  projects: ProjectsTranslations;
  diagnostics: DiagnosticsTranslations;
  dialogs: DialogsTranslations;
  stageAppearance: StageAppearanceTranslations;
  rail: RailTranslations;
  practice: PracticeTranslations;
}

export type TranslationKey = {
  [K in keyof TranslationDictionary]: `${K}.${Extract<keyof TranslationDictionary[K], string>}`;
}[keyof TranslationDictionary];

export type TranslationParams = Record<string, string | number>;

export type TranslateFunction = (path: string, params?: TranslationParams) => string;

export interface I18nContextValue {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
  t: TranslateFunction;
  dict: TranslationDictionary;
}
