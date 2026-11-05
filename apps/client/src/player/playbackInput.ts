import type { MidiInputEvent } from "../midi/types";
import type { StudioView } from "../studio/types";

export const PLAYBACK_CONTROL_SELECTOR = 'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menu"], [role="menuitem"], [role="slider"], [role="checkbox"], [role="switch"], [role="tab"], [role="dialog"], [data-testid="fingering-editor"]';
export const PLAYBACK_DIALOG_SELECTOR = '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"], dialog[open]';

export function isPlaybackToggleKey(event: Pick<KeyboardEvent, "key" | "repeat" | "defaultPrevented" | "isComposing" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return (event.key === " " || event.key === "Enter") && !event.repeat && !event.defaultPrevented &&
    !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function canUsePlaybackInput(view: StudioView, blocked: boolean): boolean {
  return !blocked && view !== "play_along" && view !== "editor";
}

export function shouldStartFromMidi(event: MidiInputEvent, pendingOrPlaying: boolean): boolean {
  return event.type === "noteOn" && event.velocity > 0 && !pendingOrPlaying;
}
