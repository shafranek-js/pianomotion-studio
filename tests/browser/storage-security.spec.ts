import { expect, test } from "@playwright/test";

test("Security limits and sanitization reject invalid and oversized payloads safely", async ({
    page,
  }) => {
    await page.goto("/");

    const securityChecks = await page.evaluate(async () => {
      // Dynamic import from client storage module
      const storage = await import("/src/storage/index.ts");

      // 1. Oversized MIDI check (17 MiB > 16 MiB limit)
      const oversizedMidiBlob = new Blob([new Uint8Array(10)], { type: "audio/midi" });
      Object.defineProperty(oversizedMidiBlob, "size", { value: 17 * 1024 * 1024 });
      const midiCheck = storage.validateMidiFile(oversizedMidiBlob, "huge.mid");

      // 2. Oversized Package check (33 MiB > 32 MiB limit)
      const oversizedPkgBlob = new Blob([new Uint8Array(10)], { type: "application/json" });
      Object.defineProperty(oversizedPkgBlob, "size", { value: 33 * 1024 * 1024 });
      const pkgCheck = storage.validatePackageFile(oversizedPkgBlob, "huge.json");

      // 3. Filename sanitization
      const sanitizedTraversal = storage.sanitizeFilename("../../../etc/passwd");
      const sanitizedDrive = storage.sanitizeFilename("C:\\Windows\\System32\\cmd.exe");
      const sanitizedReserved = storage.sanitizeFilename("con.mid");

      // 4. Safe Resource Path validation
      const safePath = storage.isSafeResourcePath("resources/audio.wav");
      const traversalPath = storage.isSafeResourcePath("../resources/audio.wav");
      const absolutePath = storage.isSafeResourcePath("/resources/audio.wav");

      return {
        midiCheckValid: midiCheck.valid,
        midiCheckCode: midiCheck.valid ? null : midiCheck.code,
        pkgCheckValid: pkgCheck.valid,
        pkgCheckCode: pkgCheck.valid ? null : pkgCheck.code,
        sanitizedTraversal,
        sanitizedDrive,
        sanitizedReserved,
        safePath,
        traversalPath,
        absolutePath,
      };
    });

    expect(securityChecks.midiCheckValid).toBe(false);
    expect(securityChecks.midiCheckCode).toBe("FILE_TOO_LARGE");

    expect(securityChecks.pkgCheckValid).toBe(false);
    expect(securityChecks.pkgCheckCode).toBe("FILE_TOO_LARGE");

    expect(securityChecks.sanitizedTraversal).toBe("etc/passwd".replace(/[/\\]/g, ""));
    expect(securityChecks.sanitizedDrive).not.toContain("C:");
    expect(securityChecks.sanitizedReserved).toBe("_con.mid");

    expect(securityChecks.safePath).toBe(true);
    expect(securityChecks.traversalPath).toBe(false);
    expect(securityChecks.absolutePath).toBe(false);
  });
