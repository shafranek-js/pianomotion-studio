import { describe, expect, it } from "vitest";
import {
  downloadPublicMidiBytes,
  isApprovedHttpsUrl,
  normalizeLicenseName,
  parseArchiveItem,
  parseCommonsResponse,
} from "./publicMidiSearch";

describe("publicMidiSearch", () => {
  it("normalizes Public Domain and Creative Commons license names", () => {
    expect(normalizeLicenseName("Public domain")).toBe("Public Domain");
    expect(normalizeLicenseName("CC0 1.0")).toBe("CC0");
    expect(normalizeLicenseName("CC BY 4.0")).toBe("CC BY");
    expect(normalizeLicenseName("CC BY-SA 3.0")).toBe("CC BY-SA");
    expect(normalizeLicenseName("CC BY-NC")).toBeNull();
    expect(normalizeLicenseName("All rights reserved")).toBeNull();
  });

  it("validates HTTPS hosts and rejects non-HTTPS or unapproved domains", () => {
    const allowed = new Set(["commons.wikimedia.org", "upload.wikimedia.org"]);
    expect(
      isApprovedHttpsUrl("https://upload.wikimedia.org/wikipedia/commons/a/b/test.mid", allowed),
    ).toBe(true);
    expect(
      isApprovedHttpsUrl("http://upload.wikimedia.org/wikipedia/commons/a/b/test.mid", allowed),
    ).toBe(false);
    expect(isApprovedHttpsUrl("https://evil.example.com/test.mid", allowed)).toBe(false);
  });

  it("parses Wikimedia Commons API responses and filters to approved licenses", () => {
    const payload = {
      query: {
        pages: [
          {
            pageid: 101,
            index: 1,
            title: "File:Bach Prelude in C.mid",
            imageinfo: [
              {
                url: "https://upload.wikimedia.org/wikipedia/commons/1/11/Bach_Prelude_in_C.mid",
                descriptionurl: "https://commons.wikimedia.org/wiki/File:Bach_Prelude_in_C.mid",
                mime: "audio/midi",
                size: 4096,
                extmetadata: {
                  LicenseShortName: { value: "Public domain" },
                  Artist: { value: "<b>J.S. Bach</b>" },
                  Credit: { value: "Public domain performance" },
                },
              },
            ],
          },
        ],
      },
    };
    const results = parseCommonsResponse(payload);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Bach Prelude in C.mid");
    expect(results[0]!.artist).toBe("J.S. Bach");
    expect(results[0]!.license).toBe("Public Domain");
  });

  it("parses Internet Archive CC0 items and validates MThd header on download", async () => {
    const archivePayload = {
      metadata: {
        identifier: "chopin-nocturne-op9-no2",
        title: "Chopin Nocturne Op. 9 No. 2",
        creator: "Frederic Chopin",
        licenseurl: "http://creativecommons.org/publicdomain/zero/1.0/",
      },
      files: [
        {
          name: "nocturne.mid",
          source: "original",
          format: "MIDI",
          size: "128",
        },
      ],
    };
    const items = parseArchiveItem("chopin-nocturne-op9-no2", archivePayload);
    expect(items).toHaveLength(1);
    expect(items[0]!.license).toBe("CC0");

    // Verify MThd header check rejects non-MIDI bytes
    const fakeNonMidiFetch = async () =>
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), { status: 200 });
    await expect(
      downloadPublicMidiBytes(items[0]!, undefined, fakeNonMidiFetch as unknown as typeof fetch),
    ).rejects.toThrow(/MThd/);
  });
});
