import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAudioContext, getMasterGain, setAudioContextForTesting, setMasterVolume } from "./audioContext.ts";
import { createOutputLimiter, OUTPUT_PEAK_CEILING } from "./outputLimiter.ts";

class NodeMock {
  connections: NodeMock[] = [];
  disconnect = vi.fn(() => { this.connections = []; });
  connect(destination: NodeMock): NodeMock {
    this.connections.push(destination);
    return destination;
  }
}

function parameter() {
  return { setValueAtTime: vi.fn() };
}

function mockContext() {
  const compressor = Object.assign(new NodeMock(), {
    threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(),
    channelCount: 0, channelCountMode: "max",
  });
  const ceiling = Object.assign(new NodeMock(), { curve: null as Float32Array | null, oversample: "2x" });
  const master = Object.assign(new NodeMock(), { gain: parameter() });
  const destination = new NodeMock();
  const context = {
    currentTime: 4,
    destination,
    createGain: () => master,
    createDynamicsCompressor: () => compressor,
    createWaveShaper: () => ceiling,
    close: vi.fn(async () => {}),
  } as unknown as AudioContext;
  return { context, compressor, ceiling, master, destination };
}

afterEach(async () => { await closeAudioContext(); });

describe("final output protection", () => {
  it("routes post-master stereo compression through a non-oversampled safety ceiling", () => {
    const { context, compressor, ceiling, master, destination } = mockContext();
    setAudioContextForTesting(context);
    expect(getMasterGain()).toBe(master);
    expect(master.connections).toEqual([compressor]);
    expect(compressor.connections).toEqual([ceiling]);
    expect(ceiling.connections).toEqual([destination]);
    expect(compressor.channelCount).toBe(2);
    expect(compressor.channelCountMode).toBe("explicit");
    expect(compressor.threshold.setValueAtTime).toHaveBeenCalledWith(0, 4);
    expect(compressor.knee.setValueAtTime).toHaveBeenCalledWith(0, 4);
    expect(compressor.ratio.setValueAtTime).toHaveBeenCalledWith(20, 4);
    expect(compressor.attack.setValueAtTime).toHaveBeenCalledWith(0, 4);
    expect(compressor.release.setValueAtTime).toHaveBeenCalledWith(0.05, 4);
    expect(ceiling.oversample).toBe("none");
    for (const volume of [0.8, 1]) {
      setMasterVolume(volume);
      expect(master.gain.setValueAtTime).toHaveBeenLastCalledWith(volume, 4);
    }
  });

  it("leaves quiet samples unchanged and bounds arbitrary finite overload in the guard curve", () => {
    const { context, ceiling } = mockContext();
    const limiter = createOutputLimiter(context);
    const curve = ceiling.curve!;
    function shape(sample: number): number {
      const position = Math.max(0, Math.min(curve.length - 1, ((sample + 1) / 2) * (curve.length - 1)));
      const index = Math.floor(position);
      const fraction = position - index;
      return curve[index] * (1 - fraction) + curve[Math.min(index + 1, curve.length - 1)] * fraction;
    }
    for (const sample of [-0.9, -0.4567, -0.01, 0, 0.01, 0.4567, 0.9]) {
      expect(shape(sample)).toBeCloseTo(sample, 7);
    }
    for (const sample of [-100, -4, -1, -0.99, 0.99, 1, 4, 100]) {
      expect(Math.abs(shape(sample))).toBeLessThanOrEqual(OUTPUT_PEAK_CEILING);
    }
    expect(shape(0)).toBe(0);
    limiter.dispose();
  });

  it("disconnects managed output before closing, and dispose is idempotent", async () => {
    const { context, compressor, ceiling, master } = mockContext();
    setAudioContextForTesting(context);
    await closeAudioContext();
    expect(master.disconnect).toHaveBeenCalledTimes(1);
    expect(compressor.disconnect).toHaveBeenCalledTimes(1);
    expect(ceiling.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(ceiling.disconnect.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(context.close).mock.invocationCallOrder[0]);
    const limiter = createOutputLimiter(context);
    limiter.dispose();
    limiter.dispose();
    expect(compressor.disconnect).toHaveBeenCalledTimes(2);
  });

  it("releases the previous graph when replacing an injected context", () => {
    const first = mockContext();
    const second = mockContext();
    setAudioContextForTesting(first.context);
    setAudioContextForTesting(second.context);
    expect(first.master.disconnect).toHaveBeenCalledTimes(1);
    expect(first.compressor.disconnect).toHaveBeenCalledTimes(1);
    expect(first.ceiling.disconnect).toHaveBeenCalledTimes(1);
    expect(second.master.connections).toEqual([second.compressor]);
  });

  it("preserves caller-owned routing when an explicit test master is supplied", () => {
    const { context, compressor, master, destination } = mockContext();
    master.connect(destination);
    setAudioContextForTesting(context, master as unknown as GainNode);
    expect(master.connections).toEqual([destination]);
    expect(compressor.connections).toEqual([]);
    setAudioContextForTesting(null);
    expect(master.connections).toEqual([destination]);
    expect(master.disconnect).not.toHaveBeenCalled();
  });
});
