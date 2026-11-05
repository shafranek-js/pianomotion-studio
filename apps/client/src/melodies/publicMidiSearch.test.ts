import { describe, expect, it } from "vitest";
import {
  downloadPublicMidiBytes,
  getFeaturedPublicMelodies,
  isApprovedHttpsUrl,
  normalizeLicenseName,
  parseArchiveItem,
  parseCommonsResponse,
} from "./publicMidiSearch";
import {
  buildExternalMusicXmlLinks,
  parseOpenScorePath,
  searchMuseTrainerCatalog,
  searchOpenScoreLieder,
} from "./musicXmlCatalogs";

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
    expect(results[0]!.format).toBe("midi");
  });

  it("parses Internet Archive CC0 items (both MIDI and MusicXML) and validates MThd header on MIDI download", async () => {
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
        {
          name: "nocturne.mxl",
          source: "original",
          format: "MusicXML",
          size: "512",
        },
      ],
    };
    const items = parseArchiveItem("chopin-nocturne-op9-no2", archivePayload);
    expect(items).toHaveLength(2);
    expect(items[0]!.license).toBe("CC0");
    expect(items[0]!.format).toBe("midi");
    expect(items[1]!.format).toBe("mxl");

    // Verify MThd header check rejects non-MIDI bytes
    const fakeNonMidiFetch = async () =>
      new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), { status: 200 });
    await expect(
      downloadPublicMidiBytes(items[0]!, undefined, fakeNonMidiFetch as unknown as typeof fetch),
    ).rejects.toThrow(/MThd/);
  });

  it("searches MuseTrainer Public Domain .mxl catalog with diacritic-insensitive matching", () => {
    const furElise = searchMuseTrainerCatalog("Fur Elise");
    expect(furElise.length).toBeGreaterThanOrEqual(3);
    expect(furElise[0]!.provider).toBe("musetrainer");
    expect(furElise[0]!.format).toBe("mxl");
    expect(furElise[0]!.url).toMatch(/^https:\/\/musetrainer\.github\.io\/library\/scores\/.+\.mxl$/);

    const debussy = searchMuseTrainerCatalog("Clair de Lune");
    expect(debussy.length).toBeGreaterThanOrEqual(1);
    expect(debussy[0]!.artist).toContain("Debussy");
  });

  it("parses and searches OpenScore Lieder CC0 .mxl paths", async () => {
    const parsed = parseOpenScorePath(
      "scores/Schubert,_Franz/Winterreise,_D.911/01_-_Gute_Nacht/lc5001501.mxl",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBe("openscore");
    expect(parsed!.source).toBe("OpenScore Lieder");
    expect(parsed!.format).toBe("mxl");
    expect(parsed!.artist).toBe("Franz Schubert");
    expect(parsed!.title).toContain("Gute Nacht");
    expect(parsed!.license).toBe("CC0");

    const offlineFetch = async () => new Response("rate limited", { status: 403 });
    const lieder = await searchOpenScoreLieder(
      "Schubert Winterreise",
      undefined,
      offlineFetch as unknown as typeof fetch,
    );
    expect(lieder.length).toBeGreaterThanOrEqual(1);
    expect(lieder[0]!.artist).toBe("Franz Schubert");
  });

  it("converts downloaded MusicXML (.mxl / .musicxml) into canonical Standard MIDI File bytes", async () => {
    const [sampleMuseTrainer] = getFeaturedPublicMelodies(1);
    expect(sampleMuseTrainer).toBeDefined();
    expect(sampleMuseTrainer!.format).toBe("mxl");

    const minimalMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const fakeXmlFetch = async () =>
      new Response(new TextEncoder().encode(minimalMusicXml), { status: 200 });

    const midiBuffer = await downloadPublicMidiBytes(
      sampleMuseTrainer!,
      undefined,
      fakeXmlFetch as unknown as typeof fetch,
    );
    const bytes = new Uint8Array(midiBuffer);
    expect(bytes[0]).toBe(0x4d); // 'M'
    expect(bytes[1]).toBe(0x54); // 'T'
    expect(bytes[2]).toBe(0x68); // 'h'
    expect(bytes[3]).toBe(0x64); // 'd'
  });

  it("builds external MusicXML discovery links for MuseScore, PianoML, GitHub, Google, and MusicXML.com", () => {
    const links = buildExternalMusicXmlLinks("Chopin nocturne");
    const ids = links.map((l) => l.id);
    expect(ids).toEqual([
      "musetrainer",
      "pianoml",
      "openscore",
      "musescore",
      "github-mxl",
      "google-mxl",
      "musicxml-dir",
    ]);
    const musescore = links.find((l) => l.id === "musescore")!;
    expect(musescore.url).toContain("instrumentation=114");
    expect(musescore.url).toContain("license=to_use_commercially");
    const github = links.find((l) => l.id === "github-mxl")!;
    expect(decodeURIComponent(github.url)).toContain("extension:mxl OR extension:musicxml piano");
    const google = links.find((l) => l.id === "google-mxl")!;
    expect(decodeURIComponent(google.url)).toContain('filetype:mxl OR filetype:musicxml "piano"');
  });
});
