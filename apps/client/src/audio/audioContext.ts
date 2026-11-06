/**
 * Singleton managed Web Audio AudioContext with master gain node.
 * Automatically handles auto-resume on the first user interaction gesture.
 */

import { createOutputLimiter, type OutputLimiter } from "./outputLimiter.ts";

let globalAudioContext: AudioContext | null = null;
let globalMasterGain: GainNode | null = null;
let globalOutputLimiter: OutputLimiter | null = null;
let managedMasterConnected = false;
let masterVolume = 0.8;
let autoResumeInitialized = false;

type GestureEventName = "pointerdown" | "keydown" | "touchstart" | "click";
const GESTURE_EVENTS: readonly GestureEventName[] = ["pointerdown", "keydown", "touchstart", "click"];

function connectMasterGain(context: AudioContext, master: GainNode): void {
  // Lightweight Node test contexts may omit native DSP nodes. Every supported
  // browser AudioContext supplies both methods, so playback uses protection.
  if (typeof context.createDynamicsCompressor === "function" && typeof context.createWaveShaper === "function") {
    globalOutputLimiter = createOutputLimiter(context);
    master.connect(globalOutputLimiter.input);
  } else {
    master.connect(context.destination);
  }
  managedMasterConnected = true;
}

function disconnectManagedOutput(): void {
  if (managedMasterConnected) globalMasterGain?.disconnect();
  managedMasterConnected = false;
  globalOutputLimiter?.dispose();
  globalOutputLimiter = null;
}

function handleUserGesture(): void {
  if (globalAudioContext && globalAudioContext.state === "suspended") {
    void globalAudioContext.resume().catch(() => {
      // Ignore autoplay errors if user gesture was not yet deemed valid by the browser
    });
  }
  if (globalAudioContext && globalAudioContext.state === "running") {
    detachGestureListeners();
  }
}

function attachGestureListeners(): void {
  if (typeof window === "undefined" || autoResumeInitialized) {
    return;
  }
  autoResumeInitialized = true;
  for (const event of GESTURE_EVENTS) {
    window.addEventListener(event, handleUserGesture, { passive: true, capture: true });
  }
}

function detachGestureListeners(): void {
  if (typeof window === "undefined") {
    return;
  }
  for (const event of GESTURE_EVENTS) {
    window.removeEventListener(event, handleUserGesture, { capture: true });
  }
  autoResumeInitialized = false;
}

/**
 * Returns the singleton AudioContext instance.
 * Lazily creates the AudioContext and connected master GainNode.
 */
export function getAudioContext(): AudioContext {
  if (!globalAudioContext) {
    const AudioContextConstructor =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : undefined;

    if (!AudioContextConstructor) {
      throw new Error("Web Audio API is not supported in this environment.");
    }

    globalAudioContext = new AudioContextConstructor();
    globalMasterGain = globalAudioContext.createGain();
    globalMasterGain.gain.setValueAtTime(masterVolume, globalAudioContext.currentTime);
    connectMasterGain(globalAudioContext, globalMasterGain);

    attachGestureListeners();
  }

  return globalAudioContext;
}

/**
 * Returns the master GainNode connected through final output protection.
 */
export function getMasterGain(): GainNode {
  if (!globalMasterGain) {
    getAudioContext();
  }
  return globalMasterGain!;
}

/**
 * Ensures the AudioContext is resumed, typically called on play or user interaction.
 */
export async function resumeAudioContext(): Promise<AudioContext> {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  return ctx;
}

/**
 * Sets the master volume in range [0, 1].
 */
export function setMasterVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  masterVolume = clamped;
  if (globalMasterGain && globalAudioContext) {
    globalMasterGain.gain.setValueAtTime(clamped, globalAudioContext.currentTime);
  }
}

/**
 * Returns the current master volume [0, 1].
 */
export function getMasterVolume(): number {
  return masterVolume;
}

/**
 * Checks if the AudioContext is currently active and running.
 */
export function isAudioContextRunning(): boolean {
  return globalAudioContext !== null && globalAudioContext.state === "running";
}

/**
 * Closes and resets the managed singleton AudioContext (useful for teardown or testing).
 */
export async function closeAudioContext(): Promise<void> {
  detachGestureListeners();
  const context = globalAudioContext;
  disconnectManagedOutput();
  globalAudioContext = null;
  globalMasterGain = null;
  if (context) {
    try {
      await context.close();
    } catch {
      // Ignore errors if context is already closed
    }
  }
}

/**
 * Injects an AudioContext instance or mock for test environments.
 */
export function setAudioContextForTesting(
  context: AudioContext | null,
  masterGain?: GainNode | null,
): void {
  disconnectManagedOutput();
  globalAudioContext = context;
  globalMasterGain = masterGain ?? null;
  if (context && !masterGain) {
    try {
      globalMasterGain = context.createGain();
      globalMasterGain.gain.setValueAtTime(masterVolume, context.currentTime);
      connectMasterGain(context, globalMasterGain);
    } catch {
      // Ignore if mock context doesn't implement destination
    }
  }
}
