import type { MidiOutputDevice, WebMidiListener, WebMidiStatus } from "./types";

/**
 * Controller for optional hardware Web MIDI output (W044).
 * Supports hot-plugging, device disconnect safety, timestamp scheduling,
 * and comprehensive panic / silence-all.
 */
export class WebMidiOutputManager {
  private midiAccess: MIDIAccess | null = null;
  private activeOutput: MIDIOutput | null = null;
  private activeDeviceId: string | null = null;
  private listeners = new Set<WebMidiListener>();
  private status: WebMidiStatus = {
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
   * Initializes Web MIDI access and scans available output devices.
   */
  public async init(): Promise<WebMidiStatus> {
    if (!this.status.supported || typeof navigator.requestMIDIAccess !== "function") {
      this.status.permission = "unsupported";
      this.notify();
      return this.getStatus();
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.status.permission = "granted";
      this.updateDeviceList();

      // Listen for connection / disconnection of MIDI hardware
      this.midiAccess.onstatechange = () => {
        this.updateDeviceList();
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status.permission = "denied";
      this.status.errorMessage = msg;
    }

    this.notify();
    return this.getStatus();
  }

  /**
   * Lists currently connected MIDI output devices.
   */
  public getStatus(): WebMidiStatus {
    return {
      ...this.status,
      devices: [...this.status.devices],
    };
  }

  /**
   * Selects an active MIDI output device by its ID, or null to disable.
   */
  public selectDevice(deviceId: string | null): boolean {
    if (this.activeDeviceId === deviceId) {
      return true;
    }

    if (this.activeOutput) {
      this.silenceAll();
      this.activeOutput = null;
    }

    this.activeDeviceId = deviceId;
    this.status.activeDeviceId = deviceId;

    if (!deviceId || !this.midiAccess) {
      this.notify();
      return true;
    }

    const output = this.midiAccess.outputs.get(deviceId);
    if (output) {
      this.activeOutput = output;
      this.notify();
      return true;
    }

    // Device not found
    this.activeDeviceId = null;
    this.status.activeDeviceId = null;
    this.notify();
    return false;
  }

  /**
   * Sends a MIDI Note On command.
   */
  public sendNoteOn(pitch: number, velocity: number, channel = 0, timestampMs?: number): void {
    if (!this.activeOutput) return;
    const clampedPitch = Math.max(0, Math.min(127, Math.round(pitch)));
    const clampedVelocity = Math.max(0, Math.min(127, Math.round(velocity)));
    const clampedChannel = Math.max(0, Math.min(15, Math.round(channel)));

    const statusByte = 0x90 | clampedChannel;
    try {
      if (timestampMs !== undefined) {
        this.activeOutput.send([statusByte, clampedPitch, clampedVelocity], timestampMs);
      } else {
        this.activeOutput.send([statusByte, clampedPitch, clampedVelocity]);
      }
    } catch {
      // Ignore transient send failures on unplugged device
    }
  }

  /**
   * Sends a MIDI Note Off command.
   */
  public sendNoteOff(pitch: number, channel = 0, timestampMs?: number): void {
    if (!this.activeOutput) return;
    const clampedPitch = Math.max(0, Math.min(127, Math.round(pitch)));
    const clampedChannel = Math.max(0, Math.min(15, Math.round(channel)));

    const statusByte = 0x80 | clampedChannel;
    try {
      if (timestampMs !== undefined) {
        this.activeOutput.send([statusByte, clampedPitch, 0], timestampMs);
      } else {
        this.activeOutput.send([statusByte, clampedPitch, 0]);
      }
    } catch {
      // Ignore transient send failures
    }
  }

  /**
   * Sends a MIDI Control Change (e.g. sustain CC 64, sostenuto CC 66, soft CC 67, volume CC 7).
   */
  public sendControlChange(controller: number, value: number, channel = 0, timestampMs?: number): void {
    if (!this.activeOutput) return;
    const clampedCtrl = Math.max(0, Math.min(127, Math.round(controller)));
    const clampedVal = Math.max(0, Math.min(127, Math.round(value)));
    const clampedChannel = Math.max(0, Math.min(15, Math.round(channel)));

    const statusByte = 0xb0 | clampedChannel;
    try {
      if (timestampMs !== undefined) {
        this.activeOutput.send([statusByte, clampedCtrl, clampedVal], timestampMs);
      } else {
        this.activeOutput.send([statusByte, clampedCtrl, clampedVal]);
      }
    } catch {
      // Ignore transient send failures
    }
  }

  /**
   * Sends panic / silence commands across all channels (All Notes Off, All Sound Off, Reset Pedals).
   */
  public silenceAll(): void {
    if (!this.activeOutput) return;
    try {
      for (let ch = 0; ch < 16; ch++) {
        const statusByte = 0xb0 | ch;
        // CC 120: All Sound Off
        this.activeOutput.send([statusByte, 120, 0]);
        // CC 123: All Notes Off
        this.activeOutput.send([statusByte, 123, 0]);
        // CC 64: Sustain Off
        this.activeOutput.send([statusByte, 64, 0]);
        // CC 66: Sostenuto Off
        this.activeOutput.send([statusByte, 66, 0]);
        // CC 67: Soft Off
        this.activeOutput.send([statusByte, 67, 0]);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Subscribes to status and device list updates.
   */
  public subscribe(listener: WebMidiListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Cleans up listeners and silences active output.
   */
  public dispose(): void {
    this.silenceAll();
    this.activeOutput = null;
    this.activeDeviceId = null;
    this.status.activeDeviceId = null;
    this.listeners.clear();
    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
      this.midiAccess = null;
    }
  }

  private updateDeviceList(): void {
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

    // Check if previously active device was disconnected
    if (this.activeDeviceId) {
      const activePort = this.midiAccess.outputs.get(this.activeDeviceId);
      if (!activePort || activePort.state !== "connected") {
        this.activeOutput = null;
        this.activeDeviceId = null;
        this.status.activeDeviceId = null;
      } else {
        this.activeOutput = activePort;
      }
    }

    this.notify();
  }

  private notify(): void {
    const current = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        // Ignore subscriber error
      }
    }
  }
}
