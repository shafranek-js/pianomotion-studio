import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebMidiOutputManager } from "./webMidiOutput";

describe("WebMidiOutputManager (W044)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles environment without Web MIDI API gracefully", async () => {
    // Stub navigator without requestMIDIAccess
    const originalRequestMIDI = navigator.requestMIDIAccess;
    // @ts-expect-error test stub
    delete navigator.requestMIDIAccess;

    const manager = new WebMidiOutputManager();
    const status = await manager.init();

    expect(status.supported).toBe(false);
    expect(status.permission).toBe("unsupported");
    expect(status.devices).toEqual([]);

    if (originalRequestMIDI) {
      navigator.requestMIDIAccess = originalRequestMIDI;
    }
  });

  it("handles permission denial gracefully", async () => {
    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockRejectedValue(new Error("SecurityError: Permission denied")),
      configurable: true,
      writable: true,
    });

    const manager = new WebMidiOutputManager();
    const status = await manager.init();

    expect(status.supported).toBe(true);
    expect(status.permission).toBe("denied");
    expect(status.errorMessage).toContain("Permission denied");
  });

  it("enumerates output devices and sends MIDI messages when permission granted", async () => {
    const mockSend = vi.fn();
    const mockOutput = {
      id: "device-1",
      name: "Roland Digital Piano",
      manufacturer: "Roland",
      state: "connected",
      send: mockSend,
    };

    const mockOutputs = new Map([["device-1", mockOutput]]);
    const mockMidiAccess = {
      outputs: mockOutputs,
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const manager = new WebMidiOutputManager();
    const status = await manager.init();

    expect(status.permission).toBe("granted");
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]?.name).toBe("Roland Digital Piano");

    // Select device
    const selectResult = manager.selectDevice("device-1");
    expect(selectResult).toBe(true);
    expect(manager.getStatus().activeDeviceId).toBe("device-1");

    // Send Note On
    manager.sendNoteOn(60, 100, 0);
    expect(mockSend).toHaveBeenCalledWith([0x90, 60, 100]);

    // Send Note Off
    manager.sendNoteOff(60, 0);
    expect(mockSend).toHaveBeenCalledWith([0x80, 60, 0]);

    // Send CC (Sustain Pedal)
    manager.sendControlChange(64, 127, 0);
    expect(mockSend).toHaveBeenCalledWith([0xb0, 64, 127]);

    // Silence all
    manager.silenceAll();
    // Verifies All Notes Off (123) and All Sound Off (120) across channels
    expect(mockSend).toHaveBeenCalledWith([0xb0, 120, 0]);
    expect(mockSend).toHaveBeenCalledWith([0xb0, 123, 0]);

    // Dispose
    manager.dispose();
    expect(manager.getStatus().activeDeviceId).toBe(null);
  });

  it("handles device disconnection safely without crashing", async () => {
    const mockOutput = {
      id: "device-2",
      name: "Yamaha Clavinova",
      manufacturer: "Yamaha",
      state: "connected",
      send: vi.fn(),
    };

    const mockOutputs = new Map([["device-2", mockOutput]]);
    const mockMidiAccess = {
      outputs: mockOutputs,
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const manager = new WebMidiOutputManager();
    await manager.init();
    manager.selectDevice("device-2");

    // Simulate device disconnect
    mockOutput.state = "disconnected";
    mockOutputs.delete("device-2");
    if (mockMidiAccess.onstatechange) {
      mockMidiAccess.onstatechange();
    }

    expect(manager.getStatus().activeDeviceId).toBe(null);

    // Sending message when device is disconnected should be a safe no-op
    expect(() => {
      manager.sendNoteOn(64, 90, 0);
      manager.sendNoteOff(64, 0);
      manager.silenceAll();
    }).not.toThrow();
  });
});
