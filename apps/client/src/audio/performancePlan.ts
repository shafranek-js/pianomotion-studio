import type { PerformancePlan } from "@handthesia/contracts";
import type { PedalState, RestoredPianoVoice } from "./sampler.ts";

export interface PerformancePlaybackState {
  voices: RestoredPianoVoice[];
  pedals: PedalState;
}

export interface PerformanceNoteInterval {
  noteId: string;
  pitch: number;
  velocity: number;
  pressTimeSeconds: number;
  releaseTimeSeconds: number;
  softPedalAtPress: boolean;
}

function initialPedals(): PedalState {
  return { sustain: false, sostenuto: false, soft: false };
}

/** Replays the ordered plan prefix to determine sounding keys and pedal state. */
export function derivePerformanceStateAt(
  plan: PerformancePlan | null | undefined,
  songTimeSeconds: number,
): PerformancePlaybackState {
  const pedals = initialPedals();
  const voices = new Map<string, RestoredPianoVoice>();
  if (!plan || !Number.isFinite(songTimeSeconds)) return { voices: [], pedals };

  for (const event of plan.events) {
    if (event.timeSeconds > songTimeSeconds) break;

    if (event.type === "press") {
      voices.set(event.noteId, {
        noteId: event.noteId,
        pitch: event.pitch,
        velocity: event.velocity,
        keyState: "down",
        heldBySostenuto: false,
        sustainedBySustain: false,
        softPedalAtPress: pedals.soft,
      });
      continue;
    }

    if (event.type === "release") {
      const voice = voices.get(event.noteId);
      if (!voice) continue;
      voice.keyState = "up";
      if (pedals.sustain) {
        voice.sustainedBySustain = true;
      } else if (!(voice.heldBySostenuto && pedals.sostenuto)) {
        voices.delete(event.noteId);
      }
      continue;
    }

    const engaged = event.value >= 64;
    if (event.controller === 64) {
      const wasEngaged = pedals.sustain;
      pedals.sustain = engaged;
      if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (voice.keyState !== "up") continue;
          voice.sustainedBySustain = false;
          if (voice.heldBySostenuto && pedals.sostenuto) continue;
          voices.delete(noteId);
        }
      }
    } else if (event.controller === 66) {
      const wasEngaged = pedals.sostenuto;
      pedals.sostenuto = engaged;
      if (!wasEngaged && engaged) {
        for (const voice of voices.values()) {
          if (voice.keyState === "down") voice.heldBySostenuto = true;
        }
      } else if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (!voice.heldBySostenuto) continue;
          voice.heldBySostenuto = false;
          if (voice.keyState !== "up") continue;
          if (pedals.sustain) voice.sustainedBySustain = true;
          else voices.delete(noteId);
        }
      }
    } else {
      pedals.soft = engaged;
    }
  }

  return { voices: [...voices.values()], pedals };
}

/**
 * Reduces the plan once into note intervals whose end is the effective damper
 * release after sustain and sostenuto have both lifted.
 */
export function extractPerformanceNotes(
  plan: PerformancePlan | null | undefined,
  songDurationSeconds: number,
): PerformanceNoteInterval[] {
  if (!plan || plan.events.length === 0) return [];

  const completed: PerformanceNoteInterval[] = [];
  const pedals = initialPedals();
  const voices = new Map<
    string,
    Omit<PerformanceNoteInterval, "releaseTimeSeconds"> & {
      keyDown: boolean;
      heldBySostenuto: boolean;
    }
  >();

  const finish = (noteId: string, releaseTimeSeconds: number) => {
    const voice = voices.get(noteId);
    if (!voice) return;
    completed.push({
      noteId: voice.noteId,
      pitch: voice.pitch,
      velocity: voice.velocity,
      pressTimeSeconds: voice.pressTimeSeconds,
      releaseTimeSeconds,
      softPedalAtPress: voice.softPedalAtPress,
    });
    voices.delete(noteId);
  };

  for (const event of plan.events) {
    if (event.type === "press") {
      const voice = {
        noteId: event.noteId,
        pitch: event.pitch,
        velocity: event.velocity,
        pressTimeSeconds: event.timeSeconds,
        softPedalAtPress: pedals.soft,
        keyDown: true,
        heldBySostenuto: false,
      };
      voices.set(event.noteId, voice);
      continue;
    }

    if (event.type === "release") {
      const voice = voices.get(event.noteId);
      if (!voice) continue;
      voice.keyDown = false;
      if (!pedals.sustain && !(voice.heldBySostenuto && pedals.sostenuto)) {
        finish(event.noteId, event.timeSeconds);
      }
      continue;
    }

    const engaged = event.value >= 64;
    if (event.controller === 64) {
      const wasEngaged = pedals.sustain;
      pedals.sustain = engaged;
      if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (!voice.keyDown && !(voice.heldBySostenuto && pedals.sostenuto)) {
            finish(noteId, event.timeSeconds);
          }
        }
      }
    } else if (event.controller === 66) {
      const wasEngaged = pedals.sostenuto;
      pedals.sostenuto = engaged;
      if (!wasEngaged && engaged) {
        for (const voice of voices.values()) {
          if (voice.keyDown) voice.heldBySostenuto = true;
        }
      } else if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (!voice.heldBySostenuto) continue;
          voice.heldBySostenuto = false;
          if (!voice.keyDown && !pedals.sustain) finish(noteId, event.timeSeconds);
        }
      }
    } else {
      pedals.soft = engaged;
    }
  }

  const endTime = Math.max(0, Number.isFinite(songDurationSeconds) ? songDurationSeconds : 0);
  for (const noteId of voices.keys()) finish(noteId, endTime);
  return completed;
}
