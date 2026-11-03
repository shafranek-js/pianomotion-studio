/**
 * Lightweight WebAudio synthesized metronome & count-in click generator.
 */

let sharedMetronomeContext: AudioContext | null = null;

function getMetronomeAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedMetronomeContext && sharedMetronomeContext.state !== "closed") {
    return sharedMetronomeContext;
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedMetronomeContext = new Ctor();
    return sharedMetronomeContext;
  } catch {
    return null;
  }
}

export function playMetronomeClick(options?: { accent?: boolean; volume?: number }): void {
  const ctx = getMetronomeAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const accent = options?.accent ?? false;
    const volume = Math.max(0.01, Math.min(1, options?.volume ?? 0.28));

    osc.type = "triangle";
    osc.frequency.setValueAtTime(accent ? 1180 : 840, now);
    osc.frequency.exponentialRampToValueAtTime(accent ? 590 : 420, now + 0.042);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(accent ? volume : volume * 0.72, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.048);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.052);
  } catch {
    // Audio playback is best-effort in restricted/headless contexts.
  }
}
