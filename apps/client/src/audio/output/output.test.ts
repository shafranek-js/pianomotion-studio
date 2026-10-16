import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SynthPerformanceOutput,
  SoundFontPerformanceOutput,
  WebMidiPerformanceOutput,
} from "./performanceOutput";
import { Transport } from "../transport";
import { SoundFontSynth } from "../soundfont/soundfontSynth";
import { WebMidiOutputManager } from "../../midi/webMidiOutput";
import { setAudioContextForTesting } from "../audioContext";
import {
  saveSoundFontAsset,
  loadSoundFontAsset,
  listSoundFontAssets,
  deleteSoundFontAsset,
  setSoundFontIdbFactory,
  closeSoundFontDb,
} from "../soundfont/soundfontAssetStore";
import { InvalidSoundFontError, MAX_SF2_FILE_BYTES } from "../soundfont/sf2Parser";

function createMockAudioContext() {
  const masterGain = {
    gain: {
      setValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      value: 0.8,
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const filter = {
    frequency: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
    },
    Q: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const osc = {
    frequency: { setValueAtTime: vi.fn() },
    detune: { setValueAtTime: vi.fn() },
    setPeriodicWave: vi.fn(),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    currentTime: 10.0,
    state: "running" as AudioContextState,
    destination: {},
    createGain: vi.fn().mockReturnValue(masterGain),
    createBiquadFilter: vi.fn().mockReturnValue(filter),
    createOscillator: vi.fn().mockReturnValue(osc),
    createPeriodicWave: vi.fn().mockReturnValue({}),
    resume: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

// Helper to create minimal valid SF2 buffer with 1 sample and 1 preset
function createMinimalValidSf2(): ArrayBuffer {
  const totalSize = 256;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // RIFF header
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, totalSize - 8, true);
  bytes.set(new TextEncoder().encode("sfbk"), 8);

  // LIST INFO
  let offset = 12;
  bytes.set(new TextEncoder().encode("LIST"), offset);
  view.setUint32(offset + 4, 20, true);
  bytes.set(new TextEncoder().encode("INFO"), offset + 8);
  bytes.set(new TextEncoder().encode("INAM"), offset + 12);
  view.setUint32(offset + 16, 8, true);
  bytes.set(new TextEncoder().encode("TestSF2\0"), offset + 20);

  offset += 8 + 20; // 40

  // LIST sdta
  bytes.set(new TextEncoder().encode("LIST"), offset);
  view.setUint32(offset + 4, 32, true);
  bytes.set(new TextEncoder().encode("sdta"), offset + 8);
  bytes.set(new TextEncoder().encode("smpl"), offset + 12);
  view.setUint32(offset + 16, 20, true);
  for (let i = 0; i < 10; i++) {
    view.setInt16(offset + 20 + i * 2, i * 100, true);
  }

  offset += 8 + 32; // 80

  // LIST pdta with shdr
  bytes.set(new TextEncoder().encode("LIST"), offset);
  view.setUint32(offset + 4, 58, true);
  bytes.set(new TextEncoder().encode("pdta"), offset + 8);

  // shdr chunk (46 bytes per sample)
  bytes.set(new TextEncoder().encode("shdr"), offset + 12);
  view.setUint32(offset + 16, 46, true);
  const shdrBase = offset + 20;
  bytes.set(new TextEncoder().encode("Sample1\0\0\0\0\0\0\0\0\0\0\0\0\0"), shdrBase);
  view.setUint32(shdrBase + 20, 0, true); // start
  view.setUint32(shdrBase + 24, 10, true); // end
  view.setUint32(shdrBase + 28, 0, true); // loopStart
  view.setUint32(shdrBase + 32, 10, true); // loopEnd
  view.setUint32(shdrBase + 36, 44100, true); // sampleRate
  view.setUint8(shdrBase + 40, 60); // originalPitch
  view.setInt8(shdrBase + 41, 0); // pitchCorrection
  view.setUint16(shdrBase + 44, 1, true); // mono sample
  view.setUint32(4, offset + 58, true); // RIFF ends after the complete pdta list

  return buffer;
}

// In-memory Mock IDB for soundfont store testing
class MockIDBStore {
  records = new Map<string, unknown>();
  completeTransaction: (() => void) | null = null;

  put(value: { id: string }): { onsuccess: (() => void) | null; onerror: null } {
    this.records.set(value.id, value);
    const req = { onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => {
      req.onsuccess?.();
      this.completeTransaction?.();
    }, 0);
    return req;
  }

  get(id: string): { result: unknown; onsuccess: (() => void) | null; onerror: null } {
    const req = { result: this.records.get(id), onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => {
      req.onsuccess?.();
      this.completeTransaction?.();
    }, 0);
    return req;
  }

  delete(id: string): { onsuccess: (() => void) | null; onerror: null } {
    this.records.delete(id);
    const req = { onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => {
      req.onsuccess?.();
      this.completeTransaction?.();
    }, 0);
    return req;
  }

  openCursor(): { result: unknown; onsuccess: (() => void) | null; onerror: null } {
    const entries = Array.from(this.records.entries());
    let idx = 0;
    const req = { result: null as unknown, onsuccess: null as (() => void) | null, onerror: null };
    const advance = () => {
      if (idx < entries.length) {
        const [key, value] = entries[idx++]!;
        req.result = {
          value,
          primaryKey: key,
          delete: () => this.delete(String(key)),
          continue: () => advance(),
        };
      } else {
        req.result = null;
      }
      req.onsuccess?.();
      if (req.result === null) this.completeTransaction?.();
    };
    setTimeout(advance, 0);
    return req;
  }
}

class MockIDBDatabase {
  stores = new Map<string, MockIDBStore>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string) {
    const store = new MockIDBStore();
    this.stores.set(name, store);
    return store;
  }
  transaction(storeNames: string[] = [], mode?: IDBTransactionMode) {
    const selectedStores = storeNames.map((name) => this.stores.get(name)!).filter(Boolean);
    const snapshots = new Map(selectedStores.map((store) => [store, new Map(store.records)]));
    const abortThisTransaction = mode === "readwrite" && abortNextSoundFontWrite;
    if (abortThisTransaction) abortNextSoundFontWrite = false;
    const transaction: {
      objectStore: (name: string) => MockIDBStore;
      onerror: (() => void) | null;
      oncomplete: (() => void) | null;
      onabort: (() => void) | null;
      error: DOMException | null;
    } = {
      objectStore: (name: string) => this.stores.get(name)!,
      onerror: null,
      oncomplete: null,
      onabort: null,
      error: null,
    };
    const completeTransaction = () => {
      for (const store of selectedStores) if (store.completeTransaction === completeTransaction) store.completeTransaction = null;
      setTimeout(() => {
        if (abortThisTransaction) {
          for (const [store, snapshot] of snapshots) store.records = snapshot;
          transaction.error = new DOMException("Mock transaction aborted", "AbortError");
          transaction.onabort?.();
        } else {
          transaction.oncomplete?.();
        }
      }, 0);
    };
    for (const store of selectedStores) store.completeTransaction = mode === "readwrite" ? completeTransaction : null;
    return transaction;
  }
  close() {}
}

let abortNextSoundFontWrite = false;
const mockIdbFactory = {
  open: () => {
    const db = new MockIDBDatabase();
    const req = {
      result: db,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    setTimeout(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    }, 0);
    return req;
  },
} as unknown as IDBFactory;

describe("PerformanceOutput Architecture & Outputs (A06, SF2, Web MIDI)", () => {
  beforeEach(() => {
    setSoundFontIdbFactory(mockIdbFactory);
    setAudioContextForTesting(createMockAudioContext());
  });

  afterEach(() => {
    setAudioContextForTesting(null);
    closeSoundFontDb();
  });

  describe("SynthPerformanceOutput", () => {
    it("wraps PianoSampler and delegates all calls properly", () => {
      const output = new SynthPerformanceOutput();
      expect(output.id).toBe("synth");

      const sampler = output.getSampler();
      const noteOnSpy = vi.spyOn(sampler, "noteOn");
      const noteOffSpy = vi.spyOn(sampler, "noteOff");
      const pedalSpy = vi.spyOn(sampler, "pedal");
      const silenceSpy = vi.spyOn(sampler, "silenceAll");

      output.noteOn("n1", 60, 100, 1.5);
      expect(noteOnSpy).toHaveBeenCalledWith("n1", 60, 100, 1.5);

      output.noteOff("n1", 60, 2.0);
      expect(noteOffSpy).toHaveBeenCalledWith("n1", 2.0);

      output.pedal(64, 127, 2.1);
      expect(pedalSpy).toHaveBeenCalledWith(64, 127, 2.1);

      output.panic();
      expect(silenceSpy).toHaveBeenCalled();

      output.dispose();
    });
  });

  describe("SoundFontPerformanceOutput", () => {
    it("maps noteId to pitch on noteOff and handles pedals and panic", () => {
      const mockSynth = {
        noteOn: vi.fn(),
        noteOff: vi.fn(),
        pedalChange: vi.fn(),
        silenceAll: vi.fn(),
        setVolume: vi.fn(),
        restoreState: vi.fn(),
        getKeyDownNotes: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
      } as unknown as SoundFontSynth;

      const output = new SoundFontPerformanceOutput(mockSynth);
      expect(output.id).toBe("soundfont");

      // noteOn tracks noteId -> pitch
      output.noteOn("note_A", 69, 110);
      expect(mockSynth.noteOn).toHaveBeenCalledWith(69, 110, "note_A", undefined);

      // noteOff without explicit pitch uses tracked pitch
      output.noteOff("note_A");
      expect(mockSynth.noteOff).toHaveBeenCalledWith("note_A", 69, undefined);

      // pedal
      output.pedal(64, 127);
      expect(mockSynth.pedalChange).toHaveBeenCalledWith(64, 127, undefined);

      // setVolume
      output.setVolume(0.75);
      expect(mockSynth.setVolume).not.toHaveBeenCalled();

      // panic
      output.panic();
      expect(mockSynth.silenceAll).toHaveBeenCalled();

      // restoreState
      output.restoreState({
        voices: [
          {
            noteId: "n_res1",
            pitch: 60,
            velocity: 90,
            keyState: "down",
            heldBySostenuto: false,
            sustainedBySustain: false,
            softPedalAtPress: false,
          },
          {
            noteId: "n_res2",
            pitch: 64,
            velocity: 80,
            keyState: "up",
            heldBySostenuto: false,
            sustainedBySustain: true,
            softPedalAtPress: false,
          },
        ],
        pedals: { sustain: true, sostenuto: false, soft: false },
      });

      expect(mockSynth.silenceAll).toHaveBeenCalled();
      expect(mockSynth.restoreState).toHaveBeenCalledWith(expect.objectContaining({ pedals: { sustain: true, sostenuto: false, soft: false } }));

      output.dispose();
      expect(mockSynth.dispose).toHaveBeenCalled();
    });
  });

  describe("WebMidiPerformanceOutput", () => {
    it("handles noteOn/noteOff with timestamp, volume CC7, and auto panic on disconnect", () => {
      const mockManager = {
        sendNoteOn: vi.fn(),
        sendNoteOff: vi.fn(),
        sendControlChange: vi.fn(),
        silenceAll: vi.fn(),
        clearScheduledMessages: vi.fn(),
        getStatus: vi.fn().mockReturnValue({ activeDeviceId: "device-1" }),
        subscribe: vi.fn().mockReturnValue(() => {}),
      } as unknown as WebMidiOutputManager;

      const mockAudioCtx = {
        currentTime: 10.0,
      } as unknown as AudioContext;

      const output = new WebMidiPerformanceOutput(mockManager, mockAudioCtx, 9);
      expect(output.id).toBe("webmidi");

      // noteOn scheduled 200ms in the future
      output.noteOn("midi_n1", 60, 95, 10.2);
      expect(mockManager.sendNoteOn).toHaveBeenCalledWith(
        60,
        95,
        9,
        expect.any(Number),
      );

      // noteOff uses remembered pitch
      output.noteOff("midi_n1", undefined, 10.5);
      expect(mockManager.sendNoteOff).toHaveBeenCalledWith(
        60,
        9,
        expect.any(Number),
      );

      // pedal
      output.pedal(64, 127, 10.6);
      expect(mockManager.sendControlChange).toHaveBeenCalledWith(
        64,
        127,
        9,
        expect.any(Number),
      );

      // volume sent via CC 7
      output.setVolume(0.8);
      expect(mockManager.sendControlChange).toHaveBeenCalledWith(7, 102, 9);

      // panic
      output.panic();
      expect(mockManager.silenceAll).toHaveBeenCalled();

      output.dispose();
    });
  });

  describe("Transport output switching on the fly", () => {
    it("allows dynamic output switching and routes events to active output", () => {
      const transport = new Transport();
      expect(transport.getOutputId()).toBe("synth");

      const mockSynth = {
        noteOn: vi.fn(),
        noteOff: vi.fn(),
        pedalChange: vi.fn(),
        silenceAll: vi.fn(),
        setVolume: vi.fn(),
        dispose: vi.fn(),
      } as unknown as SoundFontSynth;

      const sfOutput = new SoundFontPerformanceOutput(mockSynth);

      // Switch to soundfont
      transport.setOutput(sfOutput);
      expect(transport.getOutputId()).toBe("soundfont");
      expect(transport.getOutput()).toBe(sfOutput);

      // Switching back to null restores default synth
      transport.setOutput(null);
      expect(transport.getOutputId()).toBe("synth");

      transport.dispose();
    });

    it("keeps playback blocked after MIDI disconnect until a replacement output is activated", async () => {
      let midiStatusListener: ((status: { activeDeviceId: string | null; errorMessage?: string }) => void) | undefined;
      const mockManager = {
        sendNoteOn: vi.fn(),
        sendNoteOff: vi.fn(),
        sendControlChange: vi.fn(),
        silenceAll: vi.fn(),
        clearScheduledMessages: vi.fn(),
        getStatus: vi.fn().mockReturnValue({ activeDeviceId: "device-1" }),
        subscribe: vi.fn((listener: typeof midiStatusListener) => {
          midiStatusListener = listener;
          return () => {};
        }),
      } as unknown as WebMidiOutputManager;
      const transport = new Transport({ audioContext: createMockAudioContext() });
      const midiOutput = new WebMidiPerformanceOutput(mockManager, createMockAudioContext());
      transport.loadPlan({ events: [] } as never, 1);
      transport.seek(0);
      transport.setOutput(midiOutput);
      const errors: Error[] = [];
      transport.subscribeOutputError((error) => errors.push(error));

      await transport.play();
      expect(transport.getState()).toBe("playing");
      midiStatusListener?.({ activeDeviceId: null, errorMessage: "device removed" });
      expect(transport.getState()).toBe("paused");
      expect(transport.getOutputError()?.message).toBe("device removed");
      expect(errors.map((error) => error.message)).toEqual(["device removed"]);

      await transport.play();
      expect(transport.getState()).toBe("paused");

      transport.setOutput(null);
      expect(transport.getOutputError()).toBeNull();
      await transport.play();
      expect(transport.getState()).toBe("playing");
      transport.dispose();
    });
  });

  describe("SoundFont Asset Store (IndexedDB persistence)", () => {
    it("rejects invalid buffer with InvalidSoundFontError", async () => {
      const badBuffer = new TextEncoder().encode("INVALID_NON_SF2").buffer;
      await expect(saveSoundFontAsset("bad.sf2", badBuffer)).rejects.toThrow(InvalidSoundFontError);
    });

    it("rejects an oversized buffer before parsing or opening IndexedDB", async () => {
      const oversizedBuffer = new ArrayBuffer(12);
      Object.defineProperty(oversizedBuffer, "byteLength", { value: MAX_SF2_FILE_BYTES + 1 });

      await expect(saveSoundFontAsset("oversized.sf2", oversizedBuffer)).rejects.toThrow(/1 GiB/i);
    });

    it("saves valid SF2 buffer, lists assets, loads asset and deletes asset", async () => {
      const validBuffer = createMinimalValidSf2();
      const meta = await saveSoundFontAsset("MyPiano.sf2", validBuffer);

      expect(meta.name).toBe("MyPiano.sf2");
      expect(meta.byteLength).toBe(validBuffer.byteLength);
      expect(meta.presetCount).toBe(1);
      expect(meta.id).toBeDefined();

      // List assets
      const list = await listSoundFontAssets();
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.some((a) => a.id === meta.id)).toBe(true);

      // Load asset
      const loaded = await loadSoundFontAsset(meta.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.name).toBe("MyPiano.sf2");
      expect(loaded?.data).toBeInstanceOf(Blob);
      expect(loaded?.data.size).toBe(validBuffer.byteLength);

      // Delete asset
      await deleteSoundFontAsset(meta.id);
      const afterDelete = await loadSoundFontAsset(meta.id);
      expect(afterDelete).toBeNull();
    });

    it("rejects save and delete when a transaction aborts after its request succeeds", async () => {
      const validBuffer = createMinimalValidSf2();
      abortNextSoundFontWrite = true;
      await expect(saveSoundFontAsset("aborted-save.sf2", validBuffer)).rejects.toThrow(/abort/i);
      expect(await listSoundFontAssets()).toEqual([]);

      const kept = await saveSoundFontAsset("kept.sf2", validBuffer);
      abortNextSoundFontWrite = true;
      await expect(deleteSoundFontAsset(kept.id)).rejects.toThrow(/abort/i);
      expect(await loadSoundFontAsset(kept.id)).not.toBeNull();
    });
  });
});
