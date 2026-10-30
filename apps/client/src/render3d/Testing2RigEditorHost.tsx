import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Testing2RigEditor } from "./Testing2RigEditor";
import {
  getTesting2RigPreset,
  listTesting2RigPresets,
  createTesting2RigPreset,
  saveTesting2RigPreset,
  type Testing2RigPreset,
  type Testing2RigPresetDraft,
} from "./testing2RigPreset";

export interface Testing2RigEditorHostProps {
  isOpen: boolean;
  onClose(): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps the Pianist screen mounted beneath a dedicated full-screen editor overlay. */
export function Testing2RigEditorHost({ isOpen, onClose }: Testing2RigEditorHostProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [presets, setPresets] = useState<Testing2RigPreset[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void listTesting2RigPresets().then((saved) => {
      if (cancelled) return;
      setPresets(saved);
      setStorageError(null);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setStorageError(`Saved rig presets could not be listed. You can still edit the local preview. ${describeError(error)}`);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      overlayRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close rig editor"]')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      const returnFocus = returnFocusRef.current;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocusRef.current = null;
    };
  }, [isOpen]);

  const loadPreset = useCallback((presetId: string) => getTesting2RigPreset(presetId), []);

  const savePreset = useCallback(async (draft: Testing2RigPresetDraft) => {
    const saved = await saveTesting2RigPreset(createTesting2RigPreset(draft));
    setPresets((current) => [saved, ...current.filter((preset) => preset.presetId !== saved.presetId)]
      .sort((a, b) => b.createdAtUnixMs - a.createdAtUnixMs || a.presetId.localeCompare(b.presetId)));
    return saved;
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlayRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !overlayRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const keepFocusOnBackdrop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    overlayRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close rig editor"]')?.focus();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      data-testid="testing2-rig-editor-host"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(5, 8, 10, 0.72)",
        pointerEvents: "auto",
      }}
      onKeyDown={trapFocus}
      onPointerDown={keepFocusOnBackdrop}
    >
      <Testing2RigEditor
        onClose={onClose}
        presets={presets}
        onLoadPreset={loadPreset}
        onSavePreset={savePreset}
      />
      {storageError && (
        <div
          role="alert"
          aria-live="polite"
          style={{
            position: "fixed",
            zIndex: 1300,
            top: "max(0.6rem, 1.5vh)",
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(680px, calc(100vw - 2rem))",
            padding: "0.65rem 0.8rem",
            borderRadius: "0.5rem",
            background: "#3a2522",
            border: "1px solid #a85247",
            color: "#ffe7e2",
            fontSize: "0.82rem",
            overflowWrap: "anywhere",
          }}
        >
          {storageError}
        </div>
      )}
    </div>
  );
}
