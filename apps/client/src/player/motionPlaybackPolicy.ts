/** Retain enough bounded windows to absorb Worker latency without pausing sound. */
export const MOTION_RETENTION_AHEAD_SECONDS = 24;
export const MOTION_REQUEST_SECONDS = 4;

export function motionPlaybackWindow(songTime: number, duration: number, speed: number, roundTripMs = 0) {
  const rate = Math.max(0.25, Math.min(2, Number.isFinite(speed) ? speed : 1));
  const start = Math.max(0, songTime);
  const end = Math.max(start, duration);
  const latency = Math.max(0, roundTripMs) / 1000 * rate;
  const ahead = Math.min(MOTION_RETENTION_AHEAD_SECONDS, Math.max(8 * rate, 3 * latency + 2 * rate));
  const resume = Math.min(ahead, Math.max(2 * rate, latency + 0.5 * rate));
  return {
    start,
    guardEnd: Math.min(end, start + 0.1 * rate),
    resumeEnd: Math.min(end, start + resume),
    prefetchEnd: Math.min(end, start + ahead),
  };
}
