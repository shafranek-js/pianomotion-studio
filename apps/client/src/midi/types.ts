/**
 * Web MIDI Output Types & Interfaces (W044)
 */

export interface MidiOutputDevice {
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
