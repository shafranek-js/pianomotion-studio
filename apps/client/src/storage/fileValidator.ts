export const MAX_MIDI_FILE_SIZE_BYTES = 16 * 1024 * 1024; // 16 MiB = 16,777,216 bytes
export const MAX_AUDIO_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB = 104,857,600 bytes
export const MAX_PACKAGE_FILE_SIZE_BYTES = 32 * 1024 * 1024; // 32 MiB = 33,554,432 bytes

export const ALLOWED_MIDI_EXTENSIONS = [".mid", ".midi"] as const;
export const ALLOWED_AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".flac"] as const;
export const ALLOWED_PACKAGE_EXTENSIONS = [".json"] as const;

export type FileValidationErrorCode =
  | "NO_FILE_PROVIDED"
  | "INVALID_EXTENSION"
  | "FILE_TOO_LARGE"
  | "EMPTY_FILE";

export interface FileValidationSuccess {
  valid: true;
  file: File | Blob;
  filename: string;
  sizeBytes: number;
  extension: string;
}

export interface FileValidationFailure {
  valid: false;
  error: string;
  code: FileValidationErrorCode;
  file?: File | Blob;
  filename?: string;
}

export type FileValidationResult = FileValidationSuccess | FileValidationFailure;

/**
 * Extracts lowercase extension with dot (e.g. ".mid").
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return "";
  }
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Checks whether a filename ends with a recognized MIDI extension (.mid or .midi), case-insensitively.
 */
export function hasMidiExtension(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ext === ".mid" || ext === ".midi";
}

/**
 * Checks whether a filename ends with a recognized audio extension (.wav, .mp3, .ogg, or .flac), case-insensitively.
 */
export function hasAudioExtension(filename: string): boolean {
  const ext = getFileExtension(filename);
  return (ALLOWED_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Checks whether a filename ends with a recognized package extension (.json), case-insensitively.
 */
export function hasPackageExtension(filename: string): boolean {
  const ext = getFileExtension(filename);
  return (ALLOWED_PACKAGE_EXTENSIONS as readonly string[]).includes(ext);
}

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Sanitizes a filename to ensure safe storage and cross-platform compatibility.
 *
 * Rules:
 * - Strips path traversal sequences (`..`), slashes (`/`, `\`), null bytes (`\0`),
 *   control characters, and reserved Windows characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`).
 * - Trims leading/trailing dots and spaces.
 * - Handles Windows reserved device names (e.g. CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 * - Truncates to max 255 chars.
 * - Defaults to `"unnamed"` if empty.
 */
export function sanitizeFilename(filename: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    return "unnamed";
  }

  // 1. Strip null bytes and control characters (0x00-0x1F, 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  let sanitized = filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

  // 2. Strip Windows drive letter prefix (e.g. C: or D:)
  sanitized = sanitized.replace(/^[a-zA-Z]:/, "");

  // 3. Strip reserved Windows characters (< > : " | ? *)
  sanitized = sanitized.replace(/[<>:"|?*]/g, "");

  // 4. Strip slashes (/ and \)
  sanitized = sanitized.replace(/[/\\]/g, "");

  // 5. Strip path traversal sequences (..) recursively
  while (sanitized.includes("..")) {
    sanitized = sanitized.replaceAll("..", "");
  }

  // 6. Trim leading/trailing whitespace and dots
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");

  // 7. Check for Windows reserved device names
  const stem = sanitized.replace(/\.[^.]*$/, "");
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase()) || WINDOWS_RESERVED_NAMES.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  // 8. Truncate to maximum 255 characters
  if (sanitized.length > 255) {
    sanitized = sanitized.slice(0, 255);
    sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");
  }

  // 9. Default to "unnamed" if empty
  return sanitized.length > 0 ? sanitized : "unnamed";
}

const SAFE_RESOURCE_PATH_REGEX = /^resources\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;

/**
 * Validates that a resource path is safe, relative, and strictly within `resources/`.
 *
 * Rules:
 * - Must start with `resources/` and contain safe path characters (`[a-zA-Z0-9._-]`).
 * - Rejects any path with `..`, leading slash, backslash, drive letters, null bytes,
 *   or segments consisting solely of `.` or `..`.
 */
export function isSafeResourcePath(path: string): boolean {
  if (typeof path !== "string" || !path) {
    return false;
  }
  // Reject null bytes, backslashes, leading slash, path traversal
  if (path.includes("\0") || path.includes("\\") || path.includes("..")) {
    return false;
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    return false;
  }
  // Must be strictly within resources/
  if (!path.startsWith("resources/")) {
    return false;
  }
  // Validate path pattern
  if (!SAFE_RESOURCE_PATH_REGEX.test(path)) {
    return false;
  }
  // Ensure no segment is "." or ".."
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === ".." || seg.length === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Validates a MIDI file from input or drag-and-drop.
 *
 * Verifies:
 * 1. File presence and name.
 * 2. Extension is `.mid` or `.midi` (case-insensitive).
 * 3. Size is greater than 0 bytes (non-empty).
 * 4. Size does not exceed 16 MiB (`MAX_MIDI_FILE_SIZE_BYTES`).
 */
export function validateMidiFile(
  file: File | Blob | null | undefined,
  filename?: string,
): FileValidationResult {
  if (!file) {
    return {
      valid: false,
      error: "No file was selected or dropped.",
      code: "NO_FILE_PROVIDED",
    };
  }

  const name = filename ?? (file instanceof File ? file.name : "unnamed.mid");

  if (!hasMidiExtension(name)) {
    const ext = getFileExtension(name);
    const displayExt = ext ? `"${ext}"` : "(none)";
    return {
      valid: false,
      error: `Invalid file extension ${displayExt}. Expected a MIDI file (.mid or .midi).`,
      code: "INVALID_EXTENSION",
      file,
      filename: name,
    };
  }

  if (file.size === 0) {
    return {
      valid: false,
      error: `File "${name}" is empty (0 bytes).`,
      code: "EMPTY_FILE",
      file,
      filename: name,
    };
  }

  if (file.size > MAX_MIDI_FILE_SIZE_BYTES) {
    const sizeMiB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `File "${name}" (${sizeMiB} MiB) exceeds the maximum allowed size of 16 MiB.`,
      code: "FILE_TOO_LARGE",
      file,
      filename: name,
    };
  }

  return {
    valid: true,
    file,
    filename: name,
    sizeBytes: file.size,
    extension: getFileExtension(name),
  };
}

/**
 * Validates multiple MIDI files (e.g. from a multi-file selection or drop).
 */
export function validateMidiFileList(files: FileList | File[] | Iterable<File>): FileValidationResult[] {
  const list = Array.from(files);
  if (list.length === 0) {
    return [
      {
        valid: false,
        error: "No files provided.",
        code: "NO_FILE_PROVIDED",
      },
    ];
  }
  return list.map((f) => validateMidiFile(f));
}

/**
 * Checks if a DragEvent contains files during `dragenter` / `dragover`.
 * Note: DataTransfer.files is empty during dragover for browser security reasons;
 * this checks dataTransfer.types for "Files".
 */
export function isDragEventWithFiles(event: DragEvent): boolean {
  if (!event.dataTransfer) {
    return false;
  }
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Extracts and validates the primary dropped MIDI file from a DragEvent.
 */
export function extractMidiFileFromDrop(event: DragEvent): FileValidationResult {
  if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) {
    return {
      valid: false,
      error: "No files detected in drop event.",
      code: "NO_FILE_PROVIDED",
    };
  }

  const file = event.dataTransfer.files[0];
  return validateMidiFile(file);
}

/**
 * Extracts and validates all dropped MIDI files from a DragEvent.
 */
export function extractAllMidiFilesFromDrop(event: DragEvent): FileValidationResult[] {
  if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) {
    return [
      {
        valid: false,
        error: "No files detected in drop event.",
        code: "NO_FILE_PROVIDED",
      },
    ];
  }

  return Array.from(event.dataTransfer.files).map((f) => validateMidiFile(f));
}

/**
 * Validates a file from a file `<input>` change event.
 */
export function validateMidiFileInput(event: {
  target: { files: FileList | null } | null;
}): FileValidationResult {
  const files = event.target?.files;
  if (!files || files.length === 0) {
    return {
      valid: false,
      error: "No file selected.",
      code: "NO_FILE_PROVIDED",
    };
  }
  return validateMidiFile(files[0]);
}

/**
 * Validates a project package file (.json or .pianomotion.json).
 *
 * Rules:
 * - Rejects null / undefined.
 * - Rejects empty (0 bytes).
 * - Rejects files > 32 MiB (`MAX_PACKAGE_FILE_SIZE_BYTES`).
 * - Rejects non-json extension (unless blob with valid size and no filename given).
 */
export function validatePackageFile(
  file: File | Blob | null | undefined,
  filename?: string,
): FileValidationResult {
  if (!file) {
    return {
      valid: false,
      error: "No file was selected or dropped.",
      code: "NO_FILE_PROVIDED",
    };
  }

  const hasExplicitName = filename !== undefined || file instanceof File;
  const name = filename ?? (file instanceof File ? file.name : "package.json");

  if (hasExplicitName && !hasPackageExtension(name)) {
    const ext = getFileExtension(name);
    const displayExt = ext ? `"${ext}"` : "(none)";
    return {
      valid: false,
      error: `Invalid file extension ${displayExt}. Expected a JSON package (.json or .pianomotion.json).`,
      code: "INVALID_EXTENSION",
      file,
      filename: name,
    };
  }

  if (file.size === 0) {
    return {
      valid: false,
      error: `File "${name}" is empty (0 bytes).`,
      code: "EMPTY_FILE",
      file,
      filename: name,
    };
  }

  if (file.size > MAX_PACKAGE_FILE_SIZE_BYTES) {
    const sizeMiB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `File "${name}" (${sizeMiB} MiB) exceeds the maximum allowed size of 32 MiB.`,
      code: "FILE_TOO_LARGE",
      file,
      filename: name,
    };
  }

  return {
    valid: true,
    file,
    filename: name,
    sizeBytes: file.size,
    extension: getFileExtension(name),
  };
}

/**
 * Validates an audio recording file (.wav, .mp3, .ogg, .flac).
 *
 * Rules:
 * - Rejects null / undefined.
 * - Rejects empty (0 bytes).
 * - Rejects files > 100 MiB (`MAX_AUDIO_FILE_SIZE_BYTES`).
 * - Rejects unsupported audio extensions.
 */
export function validateAudioRecordingFile(
  file: File | Blob | null | undefined,
  filename?: string,
): FileValidationResult {
  if (!file) {
    return {
      valid: false,
      error: "No file was selected or dropped.",
      code: "NO_FILE_PROVIDED",
    };
  }

  const name = filename ?? (file instanceof File ? file.name : "recording.wav");
  const ext = getFileExtension(name);

  if (!hasAudioExtension(name)) {
    const displayExt = ext ? `"${ext}"` : "(none)";
    return {
      valid: false,
      error: `Invalid file extension ${displayExt}. Expected an audio file (.wav, .mp3, .ogg, or .flac).`,
      code: "INVALID_EXTENSION",
      file,
      filename: name,
    };
  }

  if (file.size === 0) {
    return {
      valid: false,
      error: `File "${name}" is empty (0 bytes).`,
      code: "EMPTY_FILE",
      file,
      filename: name,
    };
  }

  if (file.size > MAX_AUDIO_FILE_SIZE_BYTES) {
    const sizeMiB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `File "${name}" (${sizeMiB} MiB) exceeds the maximum allowed size of 100 MiB.`,
      code: "FILE_TOO_LARGE",
      file,
      filename: name,
    };
  }

  return {
    valid: true,
    file,
    filename: name,
    sizeBytes: file.size,
    extension: ext,
  };
}
