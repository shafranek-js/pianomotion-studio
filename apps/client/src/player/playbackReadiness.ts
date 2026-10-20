/** Why the existing transport cannot start or resume playback yet.
 * Keep this in lockstep with StudioTransport's disabled/playDisabled inputs.
 */
export type PlaybackBlocker = "reading" | "analysis" | "audio";

export function playbackBlocker({
  busy,
  needsReplan,
  preparingOutput,
  isPlaying,
  isBuffering,
}: {
  busy: boolean;
  needsReplan: boolean;
  preparingOutput: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
}): PlaybackBlocker | null {
  if (busy) return "reading";
  if (needsReplan) return "analysis";
  // Audio initialization blocks starting playback, but does not disable
  // the Pause button if playback is already in progress/buffering.
  if (preparingOutput && !isPlaying && !isBuffering) return "audio";
  return null;
}
