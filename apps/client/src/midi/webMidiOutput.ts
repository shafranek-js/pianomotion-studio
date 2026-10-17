import type { MidiOutputDevice, WebMidiListener, WebMidiStatus } from "./types";

let sharedMidiAccess: MIDIAccess | null = null;

export function getSharedMidiAccess(): MIDIAccess | null {
  return sharedMidiAccess;
}

export function setSharedMidiAccess(access: MIDIAccess): void {
  sharedMidiAccess = access;
}

let sharedAccessRequest: Promise<MIDIAccess> | null = null;
const attachedManagers = new Set<WebMidiOutputManager>();
let sharedManager: WebMidiOutputManager | null = null;

/**
 * Controller for optional hardware Web MIDI output. Permission is requested
 * only by `requestPermissionFromUserGesture`; `init` only reuses a grant.
 */
export class WebMidiOutputManager {
  private midiAccess: MIDIAccess | null = null;
  private activeOutput: MIDIOutput | null = null;
  private activeDeviceId: string | null = null;
  private readonly listeners = new Set<WebMidiListener>();
  private status: WebMidiStatus = {
    supported: false,
    permission: "prompt",
    devices: [],
    activeDeviceId: null,
  };

  constructor() {
    this.status.supported = typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
    if (!this.status.supported) this.status.permission = "unsupported";
  }

  /** Reuses an existing grant and never opens the browser permission prompt. */
  public async init(): Promise<WebMidiStatus> {
    if (!this.status.supported) {
      this.status.permission = "unsupported";
    } else if (sharedMidiAccess) {
      this.attachAccess(sharedMidiAccess);
    }
    this.notify();
    return this.getStatus();
  }

  /** Must be called directly from a user gesture, such as Settings > Connect. */
  public async requestPermissionFromUserGesture(): Promise<WebMidiStatus> {
    if (!this.status.supported || typeof navigator.requestMIDIAccess !== "function") {
      this.status.permission = "unsupported";
      this.notify();
      return this.getStatus();
    }

    if (sharedMidiAccess) {
      this.attachAccess(sharedMidiAccess);
      this.notify();
      return this.getStatus();
    }

    try {
      sharedAccessRequest ??= navigator.requestMIDIAccess({ sysex: false });
      sharedMidiAccess = await sharedAccessRequest;
      this.attachAccess(sharedMidiAccess);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.permission = "denied";
      this.status.errorMessage = message;
    } finally {
      sharedAccessRequest = null;
    }

    this.notify();
    return this.getStatus();
  }

  public getStatus(): WebMidiStatus {
    return { ...this.status, devices: [...this.status.devices] };
  }

  public selectDevice(deviceId: string | null): boolean {
    if (this.activeDeviceId === deviceId) return true;

    if (this.activeOutput) {
      this.clearScheduledMessages();
      this.silenceActiveOutput(this.activeOutput);
      this.activeOutput = null;
    }

    this.activeDeviceId = deviceId;
    this.status.activeDeviceId = deviceId;
    this.status.errorMessage = undefined;

    if (!deviceId || !this.midiAccess) {
      this.notify();
      return true;
    }

    const output = this.midiAccess.outputs.get(deviceId);
    if (output && output.state === "connected") {
      this.activeOutput = output;
      this.notify();
      return true;
    }

    this.activeDeviceId = null;
    this.status.activeDeviceId = null;
    this.status.errorMessage = "Selected MIDI output is not connected.";
    this.notify();
    return false;
  }

  public sendNoteOn(pitch: number, velocity: number, channel = 0, timestampMs?: number): void {
    const clampedPitch = this.clampMidiValue(pitch);
    const clampedVelocity = this.clampMidiValue(velocity);
    const statusByte = 0x90 | this.clampChannel(channel);
    this.send([statusByte, clampedPitch, clampedVelocity], timestampMs);
  }

  public sendNoteOff(pitch: number, channel = 0, timestampMs?: number): void {
    const clampedPitch = this.clampMidiValue(pitch);
    const statusByte = 0x80 | this.clampChannel(channel);
    this.send([statusByte, clampedPitch, 0], timestampMs);
  }

  public sendControlChange(controller: number, value: number, channel = 0, timestampMs?: number): void {
    const statusByte = 0xb0 | this.clampChannel(channel);
    this.send([statusByte, this.clampMidiValue(controller), this.clampMidiValue(value)], timestampMs);
  }

  /** Clears timestamped commands that have not reached the device yet. */
  public clearScheduledMessages(): void {
    try {
      (this.activeOutput as (MIDIOutput & { clear?: () => void }) | null)?.clear?.();
    } catch {
      // The port may have disconnected between status checks and this call.
    }
  }

  public silenceAll(): void {
    this.clearScheduledMessages();
    if (this.activeOutput) this.silenceActiveOutput(this.activeOutput);
  }

  public subscribe(listener: WebMidiListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  /** Detaches this manager while retaining the shared browser permission grant. */
  public dispose(): void {
    this.silenceAll();
    this.activeOutput = null;
    this.activeDeviceId = null;
    this.status.activeDeviceId = null;
    this.status.devices = [];
    this.listeners.clear();
    this.detachAccess();
  }

  public refreshDevices(): void {
    if (!this.midiAccess) return;
    const devices: MidiOutputDevice[] = [];
    for (const [id, port] of this.midiAccess.outputs.entries()) {
      devices.push({
        id,
        name: port.name ?? `MIDI Device ${id}`,
        manufacturer: port.manufacturer ?? "Generic",
        state: port.state === "connected" ? "connected" : "disconnected",
      });
    }

    this.status.devices = devices;
    if (this.activeDeviceId) {
      const port = this.midiAccess.outputs.get(this.activeDeviceId);
      if (!port || port.state !== "connected") {
        this.activeOutput = null;
        this.activeDeviceId = null;
        this.status.activeDeviceId = null;
        this.status.errorMessage = "The active MIDI output disconnected.";
      } else {
        this.activeOutput = port;
      }
    }
    this.notify();
  }

  private attachAccess(access: MIDIAccess): void {
    if (this.midiAccess === access) {
      this.status.permission = "granted";
      this.refreshDevices();
      return;
    }
    if (this.midiAccess) this.detachAccess();
    this.midiAccess = access;
    this.status.permission = "granted";
    attachedManagers.add(this);
    if (attachedManagers.size === 1) {
      access.onstatechange = () => {
        for (const manager of attachedManagers) manager.refreshDevices();
      };
    }
    this.refreshDevices();
  }

  private detachAccess(): void {
    if (!this.midiAccess) return;
    attachedManagers.delete(this);
    if (attachedManagers.size === 0 && this.midiAccess.onstatechange) {
      this.midiAccess.onstatechange = null;
    }
    this.midiAccess = null;
  }

  private send(message: number[], timestampMs?: number): void {
    if (!this.activeOutput) return;
    try {
      if (timestampMs === undefined) this.activeOutput.send(message);
      else this.activeOutput.send(message, timestampMs);
    } catch {
      // Ignore transient send failures on an unplugged device.
    }
  }

  private silenceActiveOutput(output: MIDIOutput): void {
    try {
      for (let channel = 0; channel < 16; channel++) {
        const statusByte = 0xb0 | channel;
        output.send([statusByte, 120, 0]);
        output.send([statusByte, 123, 0]);
        output.send([statusByte, 64, 0]);
        output.send([statusByte, 66, 0]);
        output.send([statusByte, 67, 0]);
      }
    } catch {
      // Ignore a device disappearing during panic.
    }
  }

  private clampMidiValue(value: number): number {
    return Math.max(0, Math.min(127, Math.round(value)));
  }

  private clampChannel(channel: number): number {
    return Math.max(0, Math.min(15, Math.round(channel)));
  }

  private notify(): void {
    const current = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        // A subscriber must not prevent other status updates.
      }
    }
  }
}

/** Shared manager for Settings and the active player transport. */
export function getSharedWebMidiOutputManager(): WebMidiOutputManager {
  sharedManager ??= new WebMidiOutputManager();
  return sharedManager;
}
