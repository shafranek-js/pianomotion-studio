export {
  detectScoreFileFormat,
  isZipBytes,
  isSmfBytes,
  isRiffRmidBytes,
  isXmlTextBytes,
  GUITAR_PRO_EXTENSIONS,
  MUSICXML_TEXT_EXTENSIONS,
  MUSICXML_COMPRESSED_EXTENSIONS,
  MUSESCORE_EXTENSIONS,
  KARAOKE_EXTENSIONS,
  MIDI_BINARY_EXTENSIONS,
  type ScoreFileFormat,
} from "./scoreFormat";

export {
  DEFAULT_SCORE_PPQ,
  DEFAULT_TEMPO_BPM,
  writeCanonicalMidiFile,
  type CanonicalHandHint,
  type CanonicalScoreNote,
  type CanonicalTempoEvent,
  type CanonicalTimeSignatureEvent,
  type CanonicalKeySignatureEvent,
  type CanonicalPedalEvent,
  type CanonicalScoreTrack,
  type CanonicalScore,
} from "./scoreToMidiBytes";

export { normalizeMidiOrKarBytes } from "./karImporter";
export {
  extractMusicXmlText,
  parseMusicXmlToCanonicalScore,
  convertMusicXmlBytesToMidi,
} from "./musicXmlImporter";
export {
  extractMscxXmlText,
  parseMscxToCanonicalScore,
  convertMsczBytesToMidi,
} from "./msczImporter";
export {
  parseGuitarProBytesToCanonicalScore,
  convertGuitarProBytesToMidi,
  type GuitarProImportOptions,
} from "./guitarProImporter";
export {
  importScoreBytesToMidi,
  importScoreFileToMidi,
  type ImportScoreFileOptions,
  type ImportedScoreResult,
} from "./importScoreFile";
