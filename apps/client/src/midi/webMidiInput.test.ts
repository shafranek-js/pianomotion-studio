import { describe, it, expect, vi, beforeEach } from "vitest";

describe("WebMidiInputManager", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("handles environment without Web MIDI API gracefully", async () => {
    const originalRequestMIDI = navigator.requestMIDIAccess;
    // @ts-expect-error test stub
    delete navigator.requestMIDIAccess;

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
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

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
    const initStatus = await manager.init();
    expect(initStatus.permission).toBe("prompt");

    const status = await manager.requestPermissionFromUserGesture();
    expect(status.supported).toBe(true);
    expect(status.permission).toBe("denied");
    expect(status.errorMessage).toContain("Permission denied");
  });

  it("receives Note On and Note Off events from connected inputs", async () => {
    const mockInput = {
      id: "input-1",
      name: "Yamaha Clavinova",
      manufacturer: "Yamaha",
      state: "connected",
      onmidimessage: null as ((e: unknown) => void) | null,
    };

    const mockInputs = new Map([["input-1", mockInput]]);
    const mockMidiAccess = {
      inputs: mockInputs,
      outputs: new Map(),
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
    const status = await manager.requestPermissionFromUserGesture();

    expect(status.permission).toBe("granted");
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]?.name).toBe("Yamaha Clavinova");
    expect(typeof mockInput.onmidimessage).toBe("function");

    const events: unknown[] = [];
    manager.subscribeInput((event) => events.push(event));

    // Send Note On: status 0x90 (channel 0), pitch 60 (C4), velocity 100
    mockInput.onmidimessage?.({
      data: new Uint8Array([0x90, 60, 100]),
      timeStamp: 1234,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "noteOn",
      pitch: 60,
      velocity: 100,
      deviceId: "input-1",
    });

    // Send Note Off via velocity 0 Note On: status 0x90, pitch 60, velocity 0
    mockInput.onmidimessage?.({
      data: new Uint8Array([0x90, 60, 0]),
      timeStamp: 1500,
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "noteOff",
      pitch: 60,
      velocity: 0,
      deviceId: "input-1",
    });

    // Send standard Note Off: status 0x80, pitch 64, velocity 64
    mockInput.onmidimessage?.({
      data: new Uint8Array([0x80, 64, 64]),
      timeStamp: 1800,
    });

    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      type: "noteOff",
      pitch: 64,
      velocity: 0,
      deviceId: "input-1",
    });
  });

  it("filters events when a specific device is selected", async () => {
    const inputA = {
      id: "dev-a",
      name: "Device A",
      manufacturer: "Vendor A",
      state: "connected",
      onmidimessage: null as ((e: unknown) => void) | null,
    };
    const inputB = {
      id: "dev-b",
      name: "Device B",
      manufacturer: "Vendor B",
      state: "connected",
      onmidimessage: null as ((e: unknown) => void) | null,
    };

    const mockMidiAccess = {
      inputs: new Map([["dev-a", inputA], ["dev-b", inputB]]),
      outputs: new Map(),
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
    await manager.requestPermissionFromUserGesture();

    manager.selectDevice("dev-a");
    expect(inputA.onmidimessage).not.toBeNull();
    expect(inputB.onmidimessage).toBeNull();

    const received: unknown[] = [];
    manager.subscribeInput((e) => received.push(e));

    inputA.onmidimessage?.({
      data: new Uint8Array([0x90, 72, 80]),
      timeStamp: 100,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ pitch: 72, deviceId: "dev-a" });
  });

  it("automatically detects and connects hardware on init without user gesture", async () => {
    const inputAuto = {
      id: "auto-piano",
      name: "Roland FP-30X",
      manufacturer: "Roland",
      state: "connected",
      onmidimessage: null as ((e: unknown) => void) | null,
    };
    const mockMidiAccess = {
      inputs: new Map([["auto-piano", inputAuto]]),
      outputs: new Map(),
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
    const status = await manager.init();

    expect(status.permission).toBe("granted");
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]?.name).toBe("Roland FP-30X");
    expect(typeof inputAuto.onmidimessage).toBe("function");
  });

  it("dynamically detects and rebinds devices when plugged in via onstatechange", async () => {
    const inputsMap = new Map<string, unknown>();
    const mockMidiAccess = {
      inputs: inputsMap,
      outputs: new Map(),
      onstatechange: null as (() => void) | null,
    };

    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: vi.fn().mockResolvedValue(mockMidiAccess),
      configurable: true,
      writable: true,
    });

    const { WebMidiInputManager } = await import("./webMidiInput");
    const manager = new WebMidiInputManager();
    await manager.init();

    expect(manager.getStatus().devices).toHaveLength(0);

    // Device plugged in
    const newKeyboard = {
      id: "hotplug-kbd",
      name: "Casio Privia",
      manufacturer: "Casio",
      state: "connected",
      onmidimessage: null as ((e: unknown) => void) | null,
    };
    inputsMap.set("hotplug-kbd", newKeyboard);

    // Trigger access.onstatechange
    mockMidiAccess.onstatechange?.();

    const statusAfter = manager.getStatus();
    expect(statusAfter.devices).toHaveLength(1);
    expect(statusAfter.devices[0]?.name).toBe("Casio Privia");
    expect(typeof newKeyboard.onmidimessage).toBe("function");
  });
});
