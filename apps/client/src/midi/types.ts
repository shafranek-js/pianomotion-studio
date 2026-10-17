/**
 * Web MIDI Output Types & Interfaces (W044)
 */

export interface MidiOutputDevice {
  id: string;
  name: string;
  manufacturer: string;
  state: "connected" | "disconnected";
}

export interface MidiInputDevice {
  id: string;
  name: string;
  manufacturer: string;
  state: "connected" | "disconnected";
}

export type MidiPermissionState = "granted" | "denied" | "unsupported" | "prompt";

export interface WebMidiStatus {
  supported: boolean;
  permission: MidiPermissionState;
  devices: MidiOutputDevice[];
  activeDeviceId: string | null;
  errorMessage?: string;
}

export type WebMidiListener = (status: WebMidiStatus) => void;

export interface WebMidiInputStatus {
  supported: boolean;
  permission: MidiPermissionState;
  devices: MidiInputDevice[];
  activeDeviceId: string | null;
  errorMessage?: string;
}

export interface MidiInputEvent {
  type: "noteOn" | "noteOff";
  pitch: number;
  velocity: number;
  timestampMs: number;
  deviceId?: string;
}

export type MidiInputEventListener = (event: MidiInputEvent) => void;
export type WebMidiInputStatusListener = (status: WebMidiInputStatus) => void;
