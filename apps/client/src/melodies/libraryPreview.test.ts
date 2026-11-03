import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playLibraryPreview,
  prepareLibraryPreview,
  stopLibraryPreview,
} from "./libraryPreview.ts";
import type { LibraryPreviewNote } from "./libraryAnalysisClient.ts";

class MockAudioParam {
  value = 1;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
  }
  setTargetAtTime(value: number): void {
    this.value = value;
  }
  cancelScheduledValues(): void {}
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class MockAudioNode {
  disconnect = vi.fn();
  connect(): void {}
}

class MockGain extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockFilter extends MockAudioNode {
  type = "lowpass";
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
}

class MockOscillator extends MockAudioNode {
  type = "triangle";
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
  setPeriodicWave(): void {}
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static rejectResume = false;
  state: AudioContextState = "suspended";
  private readonly startedAt = Date.now();
  get currentTime(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
  destination = new MockAudioNode();
  oscillators: MockOscillator[] = [];
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn(async () => {
    if (MockAudioContext.rejectResume) throw new Error("Audio permission denied");
    this.state = "running";
  });

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createGain(): MockGain {
    return new MockGain();
  }
  createBiquadFilter(): MockFilter {
    return new MockFilter();
  }
  createOscillator(): MockOscillator {
    const oscillator = new MockOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createPeriodicWave(): PeriodicWave {
    return {} as PeriodicWave;
  }
}

const previewNotes: LibraryPreviewNote[] = [
  {
    noteId: "note-1",
    pitch: 60,
    velocity: 96,
    startSeconds: 0,
    endSeconds: 0.2,
  },
];

function installMockAudioContext(): void {
  MockAudioContext.instances = [];
  MockAudioContext.rejectResume = false;
  vi.stubGlobal("AudioContext", MockAudioContext);
}

describe("local melody preview", () => {
  afterEach(async () => {
    await stopLibraryPreview();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays through a dedicated context and closes it on stop", async () => {
    installMockAudioContext();
    const handle = await playLibraryPreview(previewNotes);
    const context = MockAudioContext.instances[0]!;

    expect(context.state).toBe("running");
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();

    handle.stop();
    await handle.done;
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.state).toBe("closed");
  });

  it("stops the previous preview before starting another", async () => {
    installMockAudioContext();
    const firstReservation = prepareLibraryPreview();
    const first = await firstReservation.play(previewNotes);
    const secondReservation = prepareLibraryPreview();
    const second = await secondReservation.play([
      { ...previewNotes[0]!, noteId: "note-2", pitch: 64 },
    ]);

    expect(MockAudioContext.instances).toHaveLength(2);
    expect(MockAudioContext.instances[0]!.close).toHaveBeenCalledOnce();
    expect(MockAudioContext.instances[1]!.state).toBe("running");
    await first.done;
    await firstReservation.stop();
    expect(MockAudioContext.instances[1]!.state).toBe("running");

    await stopLibraryPreview();
    await second.done;
    expect(MockAudioContext.instances[1]!.close).toHaveBeenCalledOnce();
  });

  it("schedules long previews incrementally instead of reserving all voices at once", async () => {
    vi.useFakeTimers();
    installMockAudioContext();
    const notes = Array.from({ length: 120 }, (_, index) => ({
      noteId: `note-${index}`,
      pitch: 48 + (index % 36),
      velocity: 80,
      startSeconds: index * 0.05,
      endSeconds: index * 0.05 + 0.04,
    }));
    const reservation = prepareLibraryPreview();
    const handle = await reservation.play(notes, { seconds: 15 });
    const context = MockAudioContext.instances[0]!;
    const initiallyScheduledCount = context.oscillators.length;

    expect(initiallyScheduledCount).toBeGreaterThan(0);
    expect(initiallyScheduledCount).toBeLessThan(64 * 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(context.oscillators.length).toBeGreaterThan(initiallyScheduledCount);
    expect(context.oscillators.length).toBeLessThan(64 * 2);

    await reservation.stop();
    await handle.done;
    await vi.runOnlyPendingTimersAsync();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("rejects empty previews and closes the context if audio startup fails", async () => {
    installMockAudioContext();
    await expect(playLibraryPreview([])).rejects.toThrow(/no notes/i);
    expect(MockAudioContext.instances).toHaveLength(1);
    expect(MockAudioContext.instances[0]!.close).toHaveBeenCalledOnce();

    MockAudioContext.rejectResume = true;
    const reservation = prepareLibraryPreview();
    await Promise.resolve();
    await Promise.resolve();
    await expect(reservation.play(previewNotes)).rejects.toThrow(
      "Audio permission denied",
    );
    expect(MockAudioContext.instances[1]!.close).toHaveBeenCalledOnce();
  });
});
