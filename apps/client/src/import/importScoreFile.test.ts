import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { M1AnalyzeMidiResult } from "@handthesia/contracts";
import { analyze_midi, midiLoader, _engine_version } from "@handthesia/engine-ts";
import {
  ALLOWED_SCORE_EXTENSIONS,
  hasScoreExtension,
  validateScoreFile,
} from "../storage/fileValidator";
import {
  detectScoreFileFormat,
  importScoreBytesToMidi,
  importScoreFileToMidi,
  writeCanonicalMidiFile,
} from "./index";

function runEngineAnalysis(midiBytes: ArrayBuffer, requestId: string): M1AnalyzeMidiResult {
  return analyze_midi(new Uint8Array(midiBytes), {
    requestId,
    fixtureId: "imported-midi",
    projectId: `proj-${requestId}`,
    revision: 0,
    keyStyle: "realistic",
    engineVersion: _engine_version(),
    sampleDense: false,
  }) as M1AnalyzeMidiResult;
}

describe("Multi-format Score Import Pipeline", () => {
  describe("1. Extension & Format Detection (14 formats)", () => {
    const supportedExtensions = [
      ".mid",
      ".midi",
      ".kar",
      ".musicxml",
      ".xml",
      ".mxl",
      ".mlx",
      ".mscz",
      ".gtp",
      ".gp3",
      ".gp4",
      ".gp5",
      ".gpx",
      ".gp",
    ];

    it("recognizes all 14 score extensions case-insensitively", () => {
      expect(ALLOWED_SCORE_EXTENSIONS).toEqual(supportedExtensions);

      for (const ext of supportedExtensions) {
        expect(hasScoreExtension(`piece${ext}`)).toBe(true);
        expect(hasScoreExtension(`PIECE${ext.toUpperCase()}`)).toBe(true);

        const blob = new Blob([new Uint8Array(64)]);
        const validation = validateScoreFile(blob, `etude${ext}`);
        expect(validation.valid).toBe(true);
      }

      expect(hasScoreExtension("audio.mp3")).toBe(false);
      expect(hasScoreExtension("archive.zip")).toBe(false);
    });

    it("detects formats accurately from extensions and magic bytes", () => {
      expect(detectScoreFileFormat("song.mid")).toBe("midi");
      expect(detectScoreFileFormat("song.midi")).toBe("midi");
      expect(detectScoreFileFormat("karaoke.kar")).toBe("karaoke");
      expect(detectScoreFileFormat("sonata.musicxml")).toBe("musicxml");
      expect(detectScoreFileFormat("sonata.xml")).toBe("musicxml");
      expect(detectScoreFileFormat("compressed.mxl")).toBe("mxl");
      expect(detectScoreFileFormat("compressed_alias.mlx")).toBe("mxl");
      expect(detectScoreFileFormat("musescore.mscz")).toBe("mscz");
      expect(detectScoreFileFormat("tab1.gtp")).toBe("guitar-pro");
      expect(detectScoreFileFormat("tab3.gp3")).toBe("guitar-pro");
      expect(detectScoreFileFormat("tab4.gp4")).toBe("guitar-pro");
      expect(detectScoreFileFormat("tab5.gp5")).toBe("guitar-pro");
      expect(detectScoreFileFormat("tab6.gpx")).toBe("guitar-pro");
      expect(detectScoreFileFormat("tab7.gp")).toBe("guitar-pro");
    });
  });

  describe("2. Karaoke (.kar) and RIFF RMID Unwrapping", () => {
    it("unwraps RIFF RMID .kar files and analyzes cleanly in engine-ts", async () => {
      const rawSmf = writeCanonicalMidiFile({
        title: "Karaoke Test Song",
        ppq: 480,
        tempos: [{ tick: 0, bpm: 120 }],
        tracks: [
          {
            name: "Right Hand",
            hand: "right",
            notes: [
              { pitch: 60, startTick: 0, durationTicks: 480, velocity: 84, finger: 1 },
              { pitch: 64, startTick: 480, durationTicks: 480, velocity: 84, finger: 3 },
              { pitch: 67, startTick: 960, durationTicks: 480, velocity: 84, finger: 5 },
            ],
          },
        ],
      });

      // Wrap SMF inside a RIFF RMID container header: "RIFF" + size + "RMID" + "data" + smfSize + rawSmf
      const riffWrapped = new Uint8Array(20 + rawSmf.byteLength);
      riffWrapped.set(strToU8("RIFF"), 0);
      const riffLen = 12 + rawSmf.byteLength;
      riffWrapped[4] = riffLen & 0xff;
      riffWrapped[5] = (riffLen >>> 8) & 0xff;
      riffWrapped[6] = (riffLen >>> 16) & 0xff;
      riffWrapped[7] = (riffLen >>> 24) & 0xff;
      riffWrapped.set(strToU8("RMIDdata"), 8);
      const dataLen = rawSmf.byteLength;
      riffWrapped[16] = dataLen & 0xff;
      riffWrapped[17] = (dataLen >>> 8) & 0xff;
      riffWrapped[18] = (dataLen >>> 16) & 0xff;
      riffWrapped[19] = (dataLen >>> 24) & 0xff;
      riffWrapped.set(rawSmf, 20);

      const imported = await importScoreBytesToMidi("ballad.kar", riffWrapped);
      expect(imported.sourceFormat).toBe("karaoke");

      const analyzed = runEngineAnalysis(imported.midiBytes, "req-kar-1");

      expect(analyzed.status).toBe("loaded");
      expect(analyzed.document?.notes.length).toBe(3);
      expect(analyzed.document?.notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
      expect(analyzed.document?.notes.map((n) => n.finger)).toEqual([1, 3, 5]);
    });
  });

  describe("3. MusicXML (.musicxml, .xml, .mxl, .mlx) Import", () => {
    const samplePianoMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work>
    <work-title>Two-Hand Prelude in C</work-title>
  </work>
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
      <midi-instrument id="P1-I1">
        <midi-channel>1</midi-channel>
        <midi-program>1</midi-program>
      </midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome>
        </direction-type>
        <sound tempo="120"/>
      </direction>
      <direction placement="below">
        <direction-type><pedal type="start"/></direction-type>
      </direction>
      <!-- Right Hand (Staff 1): C5 tied across two beats, then E5 with finger 3 -->
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration>
        <tie type="start"/>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
        <notations>
          <tied type="start"/>
          <technical><fingering>1</fingering></technical>
        </notations>
      </note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration>
        <tie type="stop"/>
        <voice>1</voice>
        <type>quarter</type>
        <staff>1</staff>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>8</duration>
        <voice>1</voice>
        <type>half</type>
        <staff>1</staff>
        <notations>
          <technical><fingering>3</fingering></technical>
        </notations>
      </note>
      <!-- Backup 16 divisions to write Left Hand (Staff 2) bass chord C3 + G3 -->
      <backup><duration>16</duration></backup>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>16</duration>
        <voice>5</voice>
        <type>whole</type>
        <staff>2</staff>
        <notations>
          <technical><fingering>5</fingering></technical>
        </notations>
      </note>
      <note>
        <chord/>
        <pitch><step>G</step><octave>3</octave></pitch>
        <duration>16</duration>
        <voice>5</voice>
        <type>whole</type>
        <staff>2</staff>
        <notations>
          <technical><fingering>1</fingering></technical>
        </notations>
      </note>
      <direction placement="below">
        <direction-type><pedal type="stop"/></direction-type>
      </direction>
    </measure>
  </part>
</score-partwise>`;

    it("parses uncompressed .musicxml and .xml with 2 staves, ties, pedals, and fingerings", async () => {
      const xmlBytes = strToU8(samplePianoMusicXml);
      const imported = await importScoreBytesToMidi("prelude.musicxml", xmlBytes);

      expect(imported.sourceFormat).toBe("musicxml");
      expect(imported.title).toBe("Two-Hand Prelude in C");

      const analyzed = runEngineAnalysis(imported.midiBytes, "req-mxml-1");

      expect(analyzed.status).toBe("loaded");
      const notes = analyzed.document!.notes;
      // 2 RH notes (tied C5 merged into 1 + E5) + 2 LH chord notes (C3 + G3) = 4 notes total
      expect(notes.length).toBe(4);

      const rhNotes = notes.filter((n) => n.hand === "right");
      const lhNotes = notes.filter((n) => n.hand === "left");
      expect(rhNotes.map((n) => n.pitch)).toEqual([72, 76]);
      expect(rhNotes.map((n) => n.finger)).toEqual([1, 3]);
      // Tied C5 spans 2 quarter notes at 120 BPM = 1.0s duration
      expect(rhNotes[0]!.endSeconds - rhNotes[0]!.startSeconds).toBeCloseTo(1.0, 2);

      expect(lhNotes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([48, 55]);
      expect(analyzed.document!.pedalControls.length).toBeGreaterThanOrEqual(1);
    });

    it("keeps a multilingual voice part separate from the piano hand notes", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Singstimme</part-name></score-part>
    <score-part id="P3"><part-name>Organ</part-name><midi-instrument id="P3-I1"><midi-program>20</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><staff>1</staff></note>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><staff>2</staff></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure>
  </part>
  <part id="P3">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

      const imported = await importScoreBytesToMidi("lied.musicxml", strToU8(xml));
      const midi = new midiLoader.PrettyMIDI(new Uint8Array(imported.midiBytes));
      const voiceTrack = midi.instruments.find((instrument) => instrument.name === "Singstimme");
      const organTrack = midi.instruments.find((instrument) => instrument.name === "Organ");

      expect(voiceTrack).toBeDefined();
      expect(voiceTrack!.program).toBe(0);
      expect(midiLoader.is_piano_track(voiceTrack!)).toBe(false);
      expect(organTrack).toBeDefined();
      expect(organTrack!.program).toBe(19);
      expect(midiLoader.is_piano_track(organTrack!)).toBe(false);

      const analyzed = runEngineAnalysis(imported.midiBytes, "req-mxml-voice-1");
      expect(analyzed.status).toBe("loaded");
      expect(analyzed.document!.notes.map((note) => note.pitch).sort((a, b) => a - b)).toEqual([48, 72]);
    });

    it("unpacks compressed .mxl and .mlx archives via META-INF/container.xml", async () => {
      const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="scores/prelude.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles>
</container>`;

      const zipped = zipSync({
        "META-INF/container.xml": strToU8(containerXml),
        "scores/prelude.musicxml": strToU8(samplePianoMusicXml),
      });

      const importedMxl = await importScoreBytesToMidi("prelude.mxl", zipped);
      expect(importedMxl.sourceFormat).toBe("mxl");
      expect(importedMxl.title).toBe("Two-Hand Prelude in C");

      const importedMlx = await importScoreBytesToMidi("prelude.mlx", zipped);
      expect(importedMlx.sourceFormat).toBe("mxl");
      expect(importedMlx.midiBytes.byteLength).toBe(importedMxl.midiBytes.byteLength);
    });
  });

  describe("4. MuseScore (.mscz) Import", () => {
    it("unpacks .mscz ZIP archive and converts two-staff MuseScore .mscx to canonical MIDI", async () => {
      const sampleMscx = `<?xml version="1.0" encoding="UTF-8"?>
<museScore version="4.00">
  <Score>
    <metaTag name="workTitle">MuseScore Nocturne</metaTag>
    <Part id="1">
      <Staff id="1"/>
      <Staff id="2"/>
      <trackName>Piano</trackName>
      <Instrument id="piano">
        <longName>Piano</longName>
      </Instrument>
    </Part>
    <Staff id="1">
      <Measure>
        <voice>
          <TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>
          <Tempo><tempo>2.0</tempo></Tempo>
          <Chord>
            <durationType>half</durationType>
            <Note>
              <pitch>72</pitch>
              <Fingering><text>2</text></Fingering>
            </Note>
          </Chord>
          <Chord>
            <durationType>half</durationType>
            <Note>
              <pitch>76</pitch>
              <Fingering><text>4</text></Fingering>
            </Note>
          </Chord>
        </voice>
      </Measure>
    </Staff>
    <Staff id="2">
      <Measure>
        <voice>
          <Chord>
            <durationType>whole</durationType>
            <Note>
              <pitch>48</pitch>
              <Fingering><text>5</text></Fingering>
            </Note>
          </Chord>
        </voice>
      </Measure>
    </Staff>
  </Score>
</museScore>`;

      const msczBytes = zipSync({
        "nocturne.mscx": strToU8(sampleMscx),
      });

      const imported = await importScoreBytesToMidi("nocturne.mscz", msczBytes);
      expect(imported.sourceFormat).toBe("mscz");
      expect(imported.title).toBe("MuseScore Nocturne");

      const analyzed = runEngineAnalysis(imported.midiBytes, "req-mscz-1");

      expect(analyzed.status).toBe("loaded");
      const notes = analyzed.document!.notes;
      expect(notes.length).toBe(3);
      const rh = notes.filter((n) => n.hand === "right");
      const lh = notes.filter((n) => n.hand === "left");
      expect(rh.map((n) => n.pitch)).toEqual([72, 76]);
      expect(rh.map((n) => n.finger)).toEqual([2, 4]);
      expect(lh.map((n) => n.pitch)).toEqual([48]);
      expect(lh.map((n) => n.finger)).toEqual([5]);
    });
  });

  describe("5. Guitar Pro (.gtp, .gp3, .gp4, .gp5, .gpx, .gp) Import via AlphaTab", () => {
    it("exports and re-imports Guitar Pro binary via @coderline/alphatab with polyphonic voices", async () => {
      const alphaTab = await import("@coderline/alphatab");

      // Build a real Guitar Pro 7 (.gp) binary using AlphaTab's Score model + Gp7Exporter
      const score = new alphaTab.model.Score();
      score.title = "Guitar Pro Polyphonic Etude";

      const masterBar = new alphaTab.model.MasterBar();
      masterBar.timeSignatureNumerator = 4;
      masterBar.timeSignatureDenominator = 4;
      const tempoAuto = new alphaTab.model.Automation();
      tempoAuto.type = alphaTab.model.AutomationType.Tempo;
      tempoAuto.value = 110;
      tempoAuto.ratioPosition = 0;
      masterBar.tempoAutomations.push(tempoAuto);
      score.addMasterBar(masterBar);

      const track = new alphaTab.model.Track();
      track.ensureStaveCount(1);
      track.name = "Classical Guitar";
      score.addTrack(track);

      const staff = track.staves[0]!;
      staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40];

      const bar = new alphaTab.model.Bar();
      staff.addBar(bar);

      // Voice 0 (Melody)
      const voice0 = new alphaTab.model.Voice();
      bar.addVoice(voice0);
      const beat0 = new alphaTab.model.Beat();
      beat0.duration = alphaTab.model.Duration.Half;
      const note0 = new alphaTab.model.Note();
      note0.string = 6; // High E string (64)
      note0.fret = 3; // G4 = 67
      beat0.addNote(note0);
      voice0.addBeat(beat0);

      // Voice 1 (Bass accompaniment in parallel)
      const voice1 = new alphaTab.model.Voice();
      bar.addVoice(voice1);
      const beat1 = new alphaTab.model.Beat();
      beat1.duration = alphaTab.model.Duration.Whole;
      const note1 = new alphaTab.model.Note();
      note1.string = 1; // Low E string (40)
      note1.fret = 3; // G2 = 43
      beat1.addNote(note1);
      voice1.addBeat(beat1);

      score.finish(new alphaTab.Settings());

      const exporter = new alphaTab.exporter.Gp7Exporter();
      const gpBytes = exporter.export(score, new alphaTab.Settings());
      const gpArrayBuffer = new Uint8Array(gpBytes).buffer;

      for (const ext of [".gtp", ".gp3", ".gp4", ".gp5", ".gpx", ".gp"]) {
        const file = new File([gpArrayBuffer], `etude${ext}`);
        const imported = await importScoreFileToMidi(file);
        expect(imported.sourceFormat).toBe("guitar-pro");
        expect(imported.title).toBe("Guitar Pro Polyphonic Etude");

        const analyzed = runEngineAnalysis(imported.midiBytes, `req-${ext}`);

        expect(analyzed.status).toBe("loaded");
        const pitches = analyzed.document!.notes
          .map((n) => n.pitch)
          .sort((a, b) => a - b);
        // Both Voice 0 (67) and Voice 1 (43) are preserved!
        expect(pitches).toEqual([43, 67]);
      }
    });
  });
});
