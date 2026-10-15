import { describe, it, expect } from "vitest";
import type { SongDocument, ResourceDescriptor, PianistProfile } from "@handthesia/contracts";
import { PACKAGE_VERSION, SCHEMA_VERSION } from "@handthesia/contracts";
import {
  MAX_MIDI_FILE_SIZE_BYTES,
  MAX_AUDIO_FILE_SIZE_BYTES,
  MAX_PACKAGE_FILE_SIZE_BYTES,
  ALLOWED_MIDI_EXTENSIONS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_PACKAGE_EXTENSIONS,
  sanitizeFilename,
  isSafeResourcePath,
  validateMidiFile,
  validatePackageFile,
  validateAudioRecordingFile,
  hasAudioExtension,
  hasPackageExtension,
  parseProjectPackageJson,
  importProjectPackageFile,
  validateProjectPackage,
  assertNoPrototypePollution,
  MAX_PACKAGE_JSON_LENGTH_CHARS,
  exportProjectPackageJson,
  computeSha256Hex,
  type SavedProject,
} from "./index.ts";

function createValidSongDocument(projectId = "proj_sec_1"): SongDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    title: "Security Test Piece",
    durationSeconds: 120,
    tracks: [
      {
        trackId: "track_1",
        instrumentIndex: 0,
        name: "Piano",
        program: 0,
        hand: "right",
      },
    ],
    notes: [
      {
        noteId: "note_1",
        trackId: "track_1",
        pitch: 60,
        velocity: 80,
        startSeconds: 0.5,
        endSeconds: 1.0,
        hand: "right",
        finger: 1,
        glissando: false,
      },
    ],
    tempoMap: [
      {
        timeSeconds: 0,
        microsecondsPerQuarterNote: 500000,
        eventOrdinal: 0,
      },
    ],
    pedalControls: [],
  };
}

function createValidProfile(profileId = "prof_sec_1"): PianistProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId,
    revision: 0,
    name: "Standard Pianist",
    colorRgb: [0, 120, 215],
    anatomy: {
      reachSpanInches: 8.5,
    },
    behavior: {
      legatoSensitivity: 1.0,
    },
    skin: {},
    weights: {
      fatigue: 0.1,
    },
    createdAtUnixSeconds: 1700000000,
    modifiedAtUnixSeconds: 1700000000,
  };
}

describe("Security: File Size and Extension Validation", () => {
  describe("MIDI File Validation", () => {
    it("exports expected MAX_MIDI_FILE_SIZE_BYTES constant (16 MiB)", () => {
      expect(MAX_MIDI_FILE_SIZE_BYTES).toBe(16 * 1024 * 1024);
      expect(ALLOWED_MIDI_EXTENSIONS).toEqual([".mid", ".midi"]);
    });

    it("rejects an oversized MIDI file exceeding 16 MiB", () => {
      const oversizedBlob = { size: 16 * 1024 * 1024 + 1 } as unknown as Blob;
      const result = validateMidiFile(oversizedBlob, "huge.mid");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("FILE_TOO_LARGE");
        expect(result.error).toMatch(/exceeds the maximum allowed size of 16 MiB/);
      }
    });

    it("accepts a valid MIDI file within 16 MiB limit", () => {
      const validBlob = { size: 1024 } as unknown as Blob;
      const result = validateMidiFile(validBlob, "chopin.mid");

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.filename).toBe("chopin.mid");
        expect(result.extension).toBe(".mid");
      }
    });

    it("rejects an empty MIDI file (0 bytes)", () => {
      const emptyBlob = { size: 0 } as unknown as Blob;
      const result = validateMidiFile(emptyBlob, "empty.mid");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("EMPTY_FILE");
      }
    });

    it("rejects MIDI file with invalid extension", () => {
      const blob = { size: 500 } as unknown as Blob;
      const result = validateMidiFile(blob, "music.mp3");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("INVALID_EXTENSION");
      }
    });
  });

  describe("Package File Validation", () => {
    it("exports expected MAX_PACKAGE_FILE_SIZE_BYTES constant (32 MiB)", () => {
      expect(MAX_PACKAGE_FILE_SIZE_BYTES).toBe(32 * 1024 * 1024);
      expect(ALLOWED_PACKAGE_EXTENSIONS).toEqual([".json"]);
    });

    it("rejects an oversized package file exceeding 32 MiB", () => {
      const oversizedBlob = { size: 32 * 1024 * 1024 + 1 } as unknown as Blob;
      const result = validatePackageFile(oversizedBlob, "project.handthesia.json");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("FILE_TOO_LARGE");
        expect(result.error).toMatch(/exceeds the maximum allowed size of 32 MiB/);
      }
    });

    it("rejects an oversized package Blob in importProjectPackageFile", async () => {
      const oversizedBlob = { size: 33 * 1024 * 1024, text: async () => "{}" } as unknown as Blob;
      await expect(importProjectPackageFile(oversizedBlob)).rejects.toThrow(
        /exceeds the maximum allowed size of 32 MiB/,
      );
    });

    it("rejects oversized JSON text exceeding 64 MiB in parseProjectPackageJson", () => {
      expect(MAX_PACKAGE_JSON_LENGTH_CHARS).toBe(64 * 1024 * 1024);
      const hugeJson = { length: 65 * 1024 * 1024 } as unknown as string;
      expect(() => parseProjectPackageJson(hugeJson)).toThrow(
        /exceeds the maximum allowed length of 64 MiB/,
      );
    });

    it("accepts a valid package file within 32 MiB limit", () => {
      const validBlob = { size: 2048 } as unknown as Blob;
      const result = validatePackageFile(validBlob, "project.handthesia.json");

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.filename).toBe("project.handthesia.json");
        expect(result.extension).toBe(".json");
      }
    });

    it("accepts a raw Blob without filename if size is valid", () => {
      const blob = { size: 1024 } as unknown as Blob;
      const result = validatePackageFile(blob);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.filename).toBe("package.json");
      }
    });

    it("rejects an empty package file (0 bytes)", () => {
      const emptyBlob = { size: 0 } as unknown as Blob;
      const result = validatePackageFile(emptyBlob, "empty.json");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("EMPTY_FILE");
      }
    });

    it("rejects package file with non-json extension", () => {
      const blob = { size: 1024 } as unknown as Blob;
      const result = validatePackageFile(blob, "package.zip");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("INVALID_EXTENSION");
      }
    });

    it("hasPackageExtension correctly identifies json files", () => {
      expect(hasPackageExtension("file.json")).toBe(true);
      expect(hasPackageExtension("project.handthesia.json")).toBe(true);
      expect(hasPackageExtension("file.txt")).toBe(false);
      expect(hasPackageExtension("file.mid")).toBe(false);
    });
  });

  describe("Audio Recording File Validation", () => {
    it("exports expected MAX_AUDIO_FILE_SIZE_BYTES constant (100 MiB)", () => {
      expect(MAX_AUDIO_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
      expect(ALLOWED_AUDIO_EXTENSIONS).toEqual([".wav", ".mp3", ".ogg", ".flac"]);
    });

    it("rejects an oversized audio file exceeding 100 MiB", () => {
      const oversizedBlob = { size: 100 * 1024 * 1024 + 1 } as unknown as Blob;
      const result = validateAudioRecordingFile(oversizedBlob, "long_rec.wav");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("FILE_TOO_LARGE");
        expect(result.error).toMatch(/exceeds the maximum allowed size of 100 MiB/);
      }
    });

    it("accepts valid audio files within 100 MiB for all supported extensions", () => {
      const extensions = [".wav", ".mp3", ".ogg", ".flac"];
      for (const ext of extensions) {
        const validBlob = { size: 5 * 1024 * 1024 } as unknown as Blob;
        const result = validateAudioRecordingFile(validBlob, `track${ext}`);

        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.extension).toBe(ext);
        }
      }
    });

    it("rejects an empty audio file (0 bytes)", () => {
      const emptyBlob = { size: 0 } as unknown as Blob;
      const result = validateAudioRecordingFile(emptyBlob, "silence.wav");

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("EMPTY_FILE");
      }
    });

    it("rejects unsupported audio extensions", () => {
      const unsupported = ["track.mid", "track.txt", "track.exe", "track.aac", "track.m4a"];
      for (const name of unsupported) {
        const blob = { size: 1024 } as unknown as Blob;
        const result = validateAudioRecordingFile(blob, name);

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.code).toBe("INVALID_EXTENSION");
        }
      }
    });

    it("hasAudioExtension correctly checks audio formats", () => {
      expect(hasAudioExtension("take1.WAV")).toBe(true);
      expect(hasAudioExtension("take1.mp3")).toBe(true);
      expect(hasAudioExtension("take1.ogg")).toBe(true);
      expect(hasAudioExtension("take1.flac")).toBe(true);
      expect(hasAudioExtension("take1.midi")).toBe(false);
      expect(hasAudioExtension("take1.bin")).toBe(false);
    });
  });
});

describe("Security: sanitizeFilename", () => {
  it("sanitizes path traversal sequences (../../evil.mid -> evil.mid)", () => {
    expect(sanitizeFilename("../../evil.mid")).toBe("evil.mid");
    expect(sanitizeFilename("..\\..\\evil.mid")).toBe("evil.mid");
    expect(sanitizeFilename("../../../secret.json")).toBe("secret.json");
    expect(sanitizeFilename("....//....//evil.mid")).toBe("evil.mid");
  });

  it("sanitizes Windows drive letters and paths (C:\\boot.ini -> boot.ini)", () => {
    expect(sanitizeFilename("C:\\boot.ini")).toBe("boot.ini");
    expect(sanitizeFilename("D:/system/file.mid")).toBe("systemfile.mid");
    expect(sanitizeFilename("C:autoexec.bat")).toBe("autoexec.bat");
  });

  it("sanitizes Windows reserved device names (con.mid -> _con.mid)", () => {
    expect(sanitizeFilename("con.mid")).toBe("_con.mid");
    expect(sanitizeFilename("CON.MID")).toBe("_CON.MID");
    expect(sanitizeFilename("prn.txt")).toBe("_prn.txt");
    expect(sanitizeFilename("aux.wav")).toBe("_aux.wav");
    expect(sanitizeFilename("nul")).toBe("_nul");
    expect(sanitizeFilename("com1.json")).toBe("_com1.json");
    expect(sanitizeFilename("lpt1.mid")).toBe("_lpt1.mid");
    expect(sanitizeFilename("normal_song.mid")).toBe("normal_song.mid");
  });

  it("sanitizes null bytes and control characters (a\\0b.mid -> ab.mid)", () => {
    expect(sanitizeFilename("a\0b.mid")).toBe("ab.mid");
    expect(sanitizeFilename("file\u0001\u001f\u007fname.mid")).toBe("filename.mid");
  });

  it("strips reserved Windows characters (< > : \" | ? *)", () => {
    expect(sanitizeFilename('song<1>:ver"2"|draft?.mid*')).toBe("song1ver2draft.mid");
  });

  it("trims leading and trailing dots and spaces", () => {
    expect(sanitizeFilename("   my_song.mid   ")).toBe("my_song.mid");
    expect(sanitizeFilename("...hidden.mid...")).toBe("hidden.mid");
    expect(sanitizeFilename("  .  spaced.mid  .  ")).toBe("spaced.mid");
  });

  it("falls back to 'unnamed' if result is empty", () => {
    expect(sanitizeFilename("")).toBe("unnamed");
    expect(sanitizeFilename("   ")).toBe("unnamed");
    expect(sanitizeFilename("...")).toBe("unnamed");
    expect(sanitizeFilename("/\\:*?\"<>|")).toBe("unnamed");
    expect(sanitizeFilename(null as unknown as string)).toBe("unnamed");
    expect(sanitizeFilename(undefined as unknown as string)).toBe("unnamed");
  });

  it("truncates filename to 255 characters maximum", () => {
    const longName = "a".repeat(300) + ".mid";
    const sanitized = sanitizeFilename(longName);

    expect(sanitized.length).toBeLessThanOrEqual(255);
    expect(sanitized.length).toBe(255);
  });
});

describe("Security: isSafeResourcePath", () => {
  it("accepts valid relative resource paths within resources/", () => {
    expect(isSafeResourcePath("resources/source.mid")).toBe(true);
    expect(isSafeResourcePath("resources/audio.wav")).toBe(true);
    expect(isSafeResourcePath("resources/take-01_final.mp3")).toBe(true);
    expect(isSafeResourcePath("resources/subfolder/nested.mid")).toBe(true);
  });

  it("rejects path traversal attempts (../etc/passwd, resources/../../bad)", () => {
    expect(isSafeResourcePath("../etc/passwd")).toBe(false);
    expect(isSafeResourcePath("../../etc/shadow")).toBe(false);
    expect(isSafeResourcePath("resources/../../bad")).toBe(false);
    expect(isSafeResourcePath("resources/../evil.mid")).toBe(false);
    expect(isSafeResourcePath("resources/foo/../../evil.mid")).toBe(false);
  });

  it("rejects absolute paths with leading slash (/root, /resources/file)", () => {
    expect(isSafeResourcePath("/root")).toBe(false);
    expect(isSafeResourcePath("/resources/source.mid")).toBe(false);
    expect(isSafeResourcePath("/etc/passwd")).toBe(false);
  });

  it("rejects paths with Windows drive letters or backslashes (C:\\bad, resources\\bad)", () => {
    expect(isSafeResourcePath("C:\\bad")).toBe(false);
    expect(isSafeResourcePath("C:/bad")).toBe(false);
    expect(isSafeResourcePath("D:\\resources\\source.mid")).toBe(false);
    expect(isSafeResourcePath("resources\\source.mid")).toBe(false);
  });

  it("rejects null bytes and invalid characters", () => {
    expect(isSafeResourcePath("resources/source.mid\0.png")).toBe(false);
    expect(isSafeResourcePath("resources/source.mid\u0000")).toBe(false);
    expect(isSafeResourcePath("resources/bad:colon.mid")).toBe(false);
    expect(isSafeResourcePath("resources/bad*wildcard.mid")).toBe(false);
    expect(isSafeResourcePath("resources/bad<tag>.mid")).toBe(false);
  });

  it("rejects paths outside resources/ or with empty/dot segments", () => {
    expect(isSafeResourcePath("resources/")).toBe(false);
    expect(isSafeResourcePath("resources/.")).toBe(false);
    expect(isSafeResourcePath("resources/..")).toBe(false);
    expect(isSafeResourcePath("resources//double_slash.mid")).toBe(false);
    expect(isSafeResourcePath("other_folder/file.mid")).toBe(false);
    expect(isSafeResourcePath("")).toBe(false);
    expect(isSafeResourcePath(null as unknown as string)).toBe(false);
    expect(isSafeResourcePath(undefined as unknown as string)).toBe(false);
  });
});

describe("Security: Package Import Hardening & Attack Defense", () => {
  it("rejects package with path traversal attempt in resource path", async () => {
    const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 1, 2, 3, 4]).buffer;
    const evilDescriptor: ResourceDescriptor = {
      resourceId: "source-midi-evil",
      purpose: "source-midi",
      mediaType: "audio/midi",
      byteLength: rawMidiBytes.byteLength,
      sha256: await computeSha256Hex(rawMidiBytes),
      path: "resources/../../etc/passwd",
    };

    const maliciousPkg = {
      packageVersion: 1,
      projectId: "proj_malicious",
      document: createValidSongDocument("proj_malicious"),
      profiles: [createValidProfile("prof_1")],
      resources: [evilDescriptor],
      resourcePayloads: {
        [evilDescriptor.path]: "AQIDBA==",
      },
    };

    expect(() => validateProjectPackage(maliciousPkg)).toThrow(
      /Unsafe resource path detected|must be a safe package-relative path/i,
    );
  });

  it("rejects package with prototype pollution attack via __proto__ in JSON", () => {
    const maliciousJson = JSON.stringify({
      packageVersion: 1,
      projectId: "proj_proto_attack",
      document: createValidSongDocument("proj_proto_attack"),
      profiles: [],
      resources: [],
    }).replace('"projectId":', '"__proto__":{"pollutedAdmin":true},"projectId":');

    expect(() => parseProjectPackageJson(maliciousJson)).toThrow(
      /Prototype pollution attempt detected: forbidden property '__proto__'/i,
    );

    // Verify Object prototype was not polluted
    expect(({} as Record<string, unknown>).pollutedAdmin).toBeUndefined();
  });

  it("rejects package with constructor or prototype property in assertNoPrototypePollution", () => {
    const attackWithConstructor = {
      packageVersion: 1,
      projectId: "proj_constructor_attack",
      constructor: { evil: true },
      document: createValidSongDocument("proj_constructor_attack"),
      profiles: [],
      resources: [],
    };

    expect(() => assertNoPrototypePollution(attackWithConstructor)).toThrow(
      /Prototype pollution attempt detected: forbidden property 'constructor'/i,
    );

    const attackWithPrototype = {
      packageVersion: 1,
      projectId: "proj_prototype_attack",
      prototype: { evil: true },
      document: createValidSongDocument("proj_prototype_attack"),
      profiles: [],
      resources: [],
    };

    expect(() => assertNoPrototypePollution(attackWithPrototype)).toThrow(
      /Prototype pollution attempt detected: forbidden property 'prototype'/i,
    );

    expect(() => validateProjectPackage(attackWithConstructor)).toThrow(
      /Prototype pollution attempt detected/i,
    );
  });

  it("rejects corrupt or malformed JSON package payloads", () => {
    const corruptJson = "{ this is definitely not valid json : [[";
    expect(() => parseProjectPackageJson(corruptJson)).toThrow(
      /Failed to parse project package JSON/i,
    );
  });

  it("rejects valid JSON that does not satisfy ProjectPackageSchema", () => {
    const incompleteJson = JSON.stringify({
      packageVersion: 1,
      // Missing required projectId, document, profiles, resources
    });

    expect(() => parseProjectPackageJson(incompleteJson)).toThrow();
  });

  it("rejects package with resource payload checksum mismatch", async () => {
    const rawMidiBytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 1, 2, 3, 4]).buffer;
    const document = createValidSongDocument("proj_checksum");
    document.sourceMidiResourceId = "source_1";
    const source: ResourceDescriptor = {
      resourceId: "source_1",
      purpose: "source-midi",
      mediaType: "audio/midi",
      byteLength: rawMidiBytes.byteLength,
      sha256: await computeSha256Hex(rawMidiBytes),
      path: "resources/source.mid",
    };

    const project: SavedProject = {
      projectId: "proj_checksum",
      name: "Checksum Project",
      updatedAt: 1700000000,
      document,
      rawMidiBytes,
      profile: createValidProfile("prof_1"),
      resources: [source],
      sourceContext: { fixtureId: "checksum-fixture", keyStyle: "realistic" },
    };

    const validJson = await exportProjectPackageJson(project);
    const parsed = JSON.parse(validJson);
    expect(parsed.packageVersion).toBe(PACKAGE_VERSION);
    expect(parsed.sourceContext).toEqual({ fixtureId: "checksum-fixture", keyStyle: "realistic" });

    // Tamper with payload bytes
    parsed.resourcePayloads[source.path] = "QUJDREVGR0g="; // "ABCDEFGH" (different hash)
    const tamperedJson = JSON.stringify(parsed);

    expect(() => parseProjectPackageJson(tamperedJson)).toThrow(
      /checksum does not match its descriptor|byte length does not match/i,
    );
  });
});
