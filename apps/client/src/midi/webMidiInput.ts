import type {
  MidiInputDevice,
  MidiInputEvent,
  MidiInputEventListener,
  WebMidiInputStatus,
  WebMidiInputStatusListener,
} from "./types";
import { getSharedMidiAccess, setSharedMidiAccess } from "./webMidiOutput";

let sharedInputManager: WebMidiInputManager | null = null;

export class WebMidiInputManager {
  private midiAccess: MIDIAccess | null = null;
  private activeDeviceId: string | null = null;
  private readonly statusListeners = new Set<WebMidiInputStatusListener>();
  private readonly inputListeners = new Set<MidiInputEventListener>();
  private boundInputs = new Map<string, MIDIInput>();

  private status: WebMidiInputStatus = {
    supported: false,
    permission: "prompt",
    devices: [],
    activeDeviceId: null,
  };

  constructor() {
    this.status.supported = typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
    if (!this.status.supported) {
      this.status.permission = "unsupported";
    }
  }

  /**
   * Initializes Web MIDI input.
   * Automatically attempts to connect using already granted access or requests access.
   */
  public async init(): Promise<WebMidiInputStatus> {
    if (!this.status.supported || typeof navigator.requestMIDIAccess !== "function") {
      this.status.permission = "unsupported";
      this.notifyStatus();
      return this.getStatus();
    }

    const existing = getSharedMidiAccess();
    if (existing) {
      this.attachAccess(existing);
      this.notifyStatus();
      return this.getStatus();
    }

    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      setSharedMidiAccess(access);
      this.attachAccess(access);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.permission = "prompt";
      this.status.errorMessage = message;
    }

    this.notifyStatus();
    return this.getStatus();
  }

  /**
   * Must be called from a user gesture (e.g. click "Connect MIDI") to prompt for permission
   * and detect connected hardware.
   */
  public async requestPermissionFromUserGesture(): Promise<WebMidiInputStatus> {
    if (!this.status.supported || typeof navigator.requestMIDIAccess !== "function") {
      this.status.permission = "unsupported";
      this.notifyStatus();
      return this.getStatus();
    }

    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      setSharedMidiAccess(access);
      this.attachAccess(access);
      this.refreshDevices();
      this.rebindInputs();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.permission = "denied";
      this.status.errorMessage = message;
    }

    this.notifyStatus();
    return this.getStatus();
  }

  public getStatus(): WebMidiInputStatus {
    return {
      ...this.status,
      devices: [...this.status.devices],
    };
  }

  public selectDevice(deviceId: string | null): boolean {
    this.activeDeviceId = deviceId;
    this.status.activeDeviceId = deviceId;
    this.status.errorMessage = undefined;
    this.rebindInputs();
    this.notifyStatus();
    return true;
  }

  public subscribeStatus(listener: WebMidiInputStatusListener): () => void {
    this.statusListeners.add(listener);
    try {
      listener(this.getStatus());
    } catch {
      // Ignored
    }
    return () => this.statusListeners.delete(listener);
  }

  public subscribeInput(listener: MidiInputEventListener): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  public emitSyntheticEvent(event: MidiInputEvent): void {
    this.notifyInput(event);
  }

  public attachAccess(access: MIDIAccess): void {
    if (this.midiAccess === access) {
      this.refreshDevices();
      this.rebindInputs();
      this.notifyStatus();
      return;
    }
    this.detachAccess();

    this.midiAccess = access;
    this.status.supported = true;
    this.status.permission = "granted";
    this.status.errorMessage = undefined;

    access.onstatechange = () => {
      this.refreshDevices();
      this.rebindInputs();
      this.notifyStatus();
    };

    this.refreshDevices();
    this.rebindInputs();
    this.notifyStatus();

    if (typeof setTimeout === "function") {
      setTimeout(() => {
        if (this.midiAccess === access) {
          this.refreshDevices();
          this.rebindInputs();
          this.notifyStatus();
        }
      }, 300);
    }
  }

  public detachAccess(): void {
    for (const input of this.boundInputs.values()) {
      input.onmidimessage = null;
    }
    this.boundInputs.clear();
    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
      this.midiAccess = null;
    }
  }

  private refreshDevices(): void {
    if (!this.midiAccess) {
      this.status.devices = [];
      return;
    }

    const devices: MidiInputDevice[] = [];
    for (const input of this.midiAccess.inputs.values()) {
      devices.push({
        id: input.id,
        name: input.name || `MIDI Input (${input.id})`,
        manufacturer: input.manufacturer || "Unknown",
        state: input.state === "disconnected" ? "disconnected" : "connected",
      });
    }

    this.status.devices = devices;
    if (this.activeDeviceId && !devices.some((d) => d.id === this.activeDeviceId)) {
      this.activeDeviceId = null;
      this.status.activeDeviceId = null;
    }
  }

  private rebindInputs(): void {
    for (const input of this.boundInputs.values()) {
      input.onmidimessage = null;
    }
    this.boundInputs.clear();

    if (!this.midiAccess) return;

    for (const input of this.midiAccess.inputs.values()) {
      if (input.state === "disconnected") continue;
      if (this.activeDeviceId && input.id !== this.activeDeviceId) continue;

      const handler = (event: MIDIMessageEvent) => {
        this.handleMidiMessage(event, input.id);
      };
      input.onmidimessage = handler;
      this.boundInputs.set(input.id, input);
    }
  }

  private handleMidiMessage(event: MIDIMessageEvent, deviceId: string): void {
    if (!event.data || event.data.length < 2) return;
    const statusByte = event.data[0]!;
    const messageType = statusByte & 0xf0;
    const pitch = event.data[1]!;
    const velocity = event.data.length > 2 ? event.data[2]! : 0;
    const timestampMs = event.timeStamp || performance.now();

    if (messageType === 0x90) {
      // Note On
      if (velocity > 0) {
        this.notifyInput({ type: "noteOn", pitch, velocity, timestampMs, deviceId });
      } else {
        // Note On with velocity 0 is Note Off
        this.notifyInput({ type: "noteOff", pitch, velocity: 0, timestampMs, deviceId });
      }
    } else if (messageType === 0x80) {
      // Note Off
      this.notifyInput({ type: "noteOff", pitch, velocity: 0, timestampMs, deviceId });
    }
  }

  private notifyStatus(): void {
    const current = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(current);
      } catch {
        // Ignored
      }
    }
  }

  private notifyInput(event: MidiInputEvent): void {
    for (const listener of this.inputListeners) {
      try {
        listener(event);
      } catch {
        // Ignored
      }
    }
  }
}

export function getSharedWebMidiInputManager(): WebMidiInputManager {
  sharedInputManager ??= new WebMidiInputManager();
  return sharedInputManager;
}
