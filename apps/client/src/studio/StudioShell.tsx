import * as Dialog from "@radix-ui/react-dialog";
import clientPackage from "../../package.json";
import "./studio.css";
import {
  Activity,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Download,
  FileUp,
  FolderOpen,
  Keyboard,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Piano,
  Redo2,
  Save,
  Settings2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_STUDIO_LAYOUT_PREFERENCES,
  loadStudioLayoutPreferences,
  sanitizeStudioLayoutPreferences,
  saveStudioLayoutPreferences,
} from "./layoutPreferences.ts";
import type {
  InspectorTab,
  StudioLayoutPreferences,
  StudioShellProps,
  StudioView,
} from "./types.ts";
import { normalizeStudioView } from "./types.ts";

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "scene", label: "Scene" },
  { id: "pianist", label: "Pianist" },
  { id: "audio", label: "Audio" },
  { id: "diagnostics", label: "Diagnostics" },
];

const viewOptions: Array<{ id: StudioView; label: string }> = [
  { id: "performance", label: "Performance" },
  { id: "editor", label: "Fingering" },
];

const editorShortcuts = [
  { key: "Ctrl / Cmd + A", description: "Select all notes" },
  { key: "Escape", description: "Clear the current selection" },
  { key: "← / →", description: "Select the previous or next note by time" },
  { key: "1 – 5", description: "Assign a finger to selected notes" },
  { key: "0", description: "Clear manual fingering for automatic replanning" },
  { key: "Delete / Backspace", description: "Mark selected notes unplayable" },
  { key: "L / R", description: "Assign the left or right hand" },
  { key: "G", description: "Toggle glissando" },
  { key: "Ctrl / Cmd + Z", description: "Undo the last edit" },
  { key: "Ctrl / Cmd + Y", description: "Redo the last edit" },
  { key: "Ctrl / Cmd + Shift + Z", description: "Redo the last edit" },
];

const studioPackageVersion = clientPackage.version;

type PanelKind = "projects" | "inspector";
type ResizeSide = "left" | "right";

export function StudioShell(props: StudioShellProps) {
  const {
    projectName,
    hasProject,
    viewMode,
    onViewModeChange,
    status,
    busy = false,
    onOpenMidi,
    onOpenBuiltinMelodies,
    onOpenPackage,
    onSave,
    onExportMidi,
    onExportPackage,
    onExportVideo,
    videoExportUnavailableReason,
    canSave,
    canExport,
    onOpenPreferences,
    onOpenPianist,
    projectsPanel,
    inspector,
    workspace,
    transport,
    footerAddon,
    dialogs,
    headerAddon,
    editActions,
  } = props;
  const [preferences, setPreferences] = useState<StudioLayoutPreferences>({
    ...DEFAULT_STUDIO_LAYOUT_PREFERENCES,
  });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [menu, setMenu] = useState<"file" | "edit" | "export" | "help" | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [preferenceSaveError, setPreferenceSaveError] = useState(false);
  const resizeRef = useRef<{ side: ResizeSide; startX: number; startWidth: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const exportMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const helpMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const panelReturnFocusRef = useRef<HTMLElement | null>(null);
  const responsiveSheetTransitionRef = useRef(false);
  const mobileStateRef = useRef(viewportWidth < 900);
  const panelTriggersRef = useRef<Record<PanelKind, HTMLButtonElement | null>>({ projects: null, inspector: null });

  const menuTriggerRef = useCallback((target: NonNullable<typeof menu>) => {
    if (target === "file") return fileMenuTriggerRef;
    if (target === "edit") return editMenuTriggerRef;
    if (target === "export") return exportMenuTriggerRef;
    return helpMenuTriggerRef;
  }, []);

  const isMobileSheet = viewportWidth < 900;
  const effectiveView: StudioView = normalizeStudioView(viewMode);
  const activePanelSide: ResizeSide = preferences.activePanel === "projects" ? "left" : "right";
  const panelWidth = activePanelSide === "left" ? preferences.leftWidth : preferences.rightWidth;
  const availableCenterWidth = viewportWidth - panelWidth - (viewportWidth >= 900 ? 72 : 24);
  const canDock = Boolean(
    preferences.activePanel && preferences.pinnedSide && viewportWidth >= 1440 &&
    availableCenterWidth >= 960 && !preferences.focusMode,
  );
  const shownDock = canDock ? preferences.activePanel : null;
  const overlayPanel = !isMobileSheet && !canDock && !preferences.focusMode ? preferences.activePanel : null;
  const mobilePanel = isMobileSheet && !preferences.focusMode ? preferences.activePanel : null;
  const overlaySide = activePanelSide;
  const activeWidth = overlaySide === "left" ? preferences.leftWidth : preferences.rightWidth;
  const desktopPanel = overlayPanel ?? shownDock;

  const updatePreferences = useCallback((update: (current: StudioLayoutPreferences) => StudioLayoutPreferences) => {
    setHasInteracted(true);
    setPreferences((current) => sanitizeStudioLayoutPreferences(update(current)));
  }, []);

  useEffect(() => {
    let live = true;
    void loadStudioLayoutPreferences().then((loaded) => {
      if (!live) return;
      if (!hasInteracted) setPreferences(loaded);
    }).catch(() => {
      if (!live) return;
      setPreferences(DEFAULT_STUDIO_LAYOUT_PREFERENCES);
    }).finally(() => {
      if (live) setPreferencesReady(true);
    });
    return () => { live = false; };
  }, [hasInteracted]);

  useEffect(() => {
    if (!preferencesReady) return;
    const timer = window.setTimeout(() => {
      void saveStudioLayoutPreferences(preferences).then(() => {
        setPreferenceSaveError(false);
      }).catch(() => {
        setPreferenceSaveError(true);
      });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [preferences, preferencesReady]);

  useEffect(() => {
    const updateWidth = () => {
      const nextMobile = window.innerWidth < 900;
      if (nextMobile !== mobileStateRef.current) {
        responsiveSheetTransitionRef.current = Boolean(document.querySelector(
          '.studio-shell [data-testid="projects-panel"], .studio-shell [data-testid="inspector-panel"]',
        ));
        mobileStateRef.current = nextMobile;
      }
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", updateWidth, { passive: true });
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    if (shortcutsOpen || menu || isMobileSheet || !desktopPanel) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(
        '[role="dialog"], [aria-modal="true"], [role="menu"]',
      )) return;
      event.preventDefault();
      updatePreferences((current) => ({ ...current, activePanel: null }));
      window.requestAnimationFrame(() => {
        const returnTarget = panelReturnFocusRef.current ?? panelTriggersRef.current[desktopPanel];
        if (returnTarget?.isConnected) returnTarget.focus();
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutsOpen, menu, isMobileSheet, desktopPanel, updatePreferences]);

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      const direction = drag.side === "left" ? 1 : -1;
      const nextWidth = drag.startWidth + (event.clientX - drag.startX) * direction;
      updatePreferences((current) => drag.side === "left"
        ? { ...current, leftWidth: nextWidth }
        : { ...current, rightWidth: nextWidth });
    };
    const onPointerUp = () => { resizeRef.current = null; };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [updatePreferences]);

  useEffect(() => {
    if (!menu) return;
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        menuTriggerRef(menu).current?.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menu, menuTriggerRef]);

  const openPanel = (panel: PanelKind, opener?: HTMLElement) => {
    if (opener) panelReturnFocusRef.current = opener;
    updatePreferences((current) => ({
      ...current,
      activePanel: current.activePanel === panel ? null : panel,
      pinnedSide: current.activePanel !== panel && current.pinnedSide
        ? panel === "projects" ? "left" : "right"
        : current.pinnedSide,
    }));
  };
  const closePanel = () => {
    updatePreferences((current) => ({ ...current, activePanel: null }));
    window.requestAnimationFrame(() => {
      if (panelReturnFocusRef.current?.isConnected) panelReturnFocusRef.current.focus();
    });
  };
  const toggleFocusMode = () => updatePreferences((current) => ({ ...current, focusMode: !current.focusMode }));
  const openDiagnostics = (event: ReactMouseEvent<HTMLButtonElement>) => {
    panelReturnFocusRef.current = event.currentTarget;
    updatePreferences((current) => ({
      ...current,
      activePanel: "inspector",
      pinnedSide: current.pinnedSide ? "right" : null,
      inspectorTab: "diagnostics",
      focusMode: false,
    }));
  };
  const changeInspectorTab = (tab: InspectorTab) => updatePreferences((current) => ({ ...current, inspectorTab: tab }));
  const setPanelPinned = (panel: PanelKind, _side: ResizeSide) => {
    const assignedSide: ResizeSide = panel === "projects" ? "left" : "right";
    if (_side !== assignedSide) return;
    updatePreferences((current) => ({
      ...current,
      activePanel: panel,
      pinnedSide: current.pinnedSide === assignedSide ? null : assignedSide,
    }));
  };

  const startResize = (side: ResizeSide, event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? preferences.leftWidth : preferences.rightWidth,
    };
  };

  const resizeWithKeyboard = (side: ResizeSide, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const increment = event.shiftKey ? 24 : 8;
    const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    updatePreferences((current) => side === "left"
      ? { ...current, leftWidth: current.leftWidth + direction * increment }
      : { ...current, rightWidth: current.rightWidth + direction * increment });
  };

  const resizeHandle = (side: ResizeSide) => (
    <div
      className="studio-resize-handle"
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation="vertical"
      aria-valuemin={side === "left" ? 280 : 300}
      aria-valuemax={side === "left" ? 400 : 440}
      aria-valuenow={side === "left" ? preferences.leftWidth : preferences.rightWidth}
      tabIndex={0}
      onPointerDown={(event) => startResize(side, event)}
      onKeyDown={(event) => resizeWithKeyboard(side, event)}
    />
  );

  const inspectorContent = useMemo(() => typeof inspector === "function"
    ? inspector(preferences.inspectorTab)
    : inspector, [inspector, preferences.inspectorTab]);

  const getPanelContent = (panel: PanelKind): ReactNode => panel === "projects" ? projectsPanel : (
    <div className="studio-inspector-content">
      <div className="studio-inspector-tabs" role="tablist" aria-label="Inspector sections">
        {inspectorTabs.map((tab) => (
          <button
            type="button"
            role="tab"
            id={`studio-inspector-tab-${tab.id}`}
            aria-controls="studio-inspector-tabpanel"
            aria-selected={preferences.inspectorTab === tab.id}
            tabIndex={preferences.inspectorTab === tab.id ? 0 : -1}
            data-tab={tab.id}
            className={preferences.inspectorTab === tab.id ? "is-active" : ""}
            key={tab.id}
            onClick={() => changeInspectorTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? []);
              const currentIndex = buttons.indexOf(event.currentTarget);
              const nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
              const nextTab = buttons[nextIndex];
              const tabId = nextTab?.dataset.tab as InspectorTab | undefined;
              if (nextTab && tabId) {
                changeInspectorTab(tabId);
                nextTab.focus();
              }
            }}
          >{tab.label}</button>
        ))}
      </div>
      <div id="studio-inspector-tabpanel" role="tabpanel" aria-labelledby={`studio-inspector-tab-${preferences.inspectorTab}`}>
        {inspectorContent}
      </div>
    </div>
  );

  const workspaceLayout = { effectiveView, focusMode: preferences.focusMode };
  // StudioShell intentionally calls this public render prop to supply current shell state.
  const workspaceContent = typeof workspace === "function" ? workspace(workspaceLayout) : workspace;

  const canSaveProject = Boolean(onSave && hasProject && !busy && canSave !== false);
  const canExportProject = Boolean(hasProject && !busy && canExport !== false);
  const toggleMenu = (next: NonNullable<typeof menu>) => setMenu((current) => current === next ? null : next);
  const chooseFromMenu = (action: () => void, restoreFocus = true) => {
    const closingMenu = menu;
    setMenu(null);
    action();
    if (restoreFocus && closingMenu) {
      window.requestAnimationFrame(() => menuTriggerRef(closingMenu).current?.focus({ preventScroll: true }));
    }
  };
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex < 0 ? items.length - 1 : currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };
  const activeMenuRef = (node: HTMLDivElement | null) => { menuRef.current = node; };

  const pinnedSide = preferences.pinnedSide;
  const pinnedPanelWidth = pinnedSide === "left" ? preferences.leftWidth : preferences.rightWidth;
  const mainStyle = shownDock && pinnedSide
    ? pinnedSide === "left"
      ? { gridTemplateColumns: `${pinnedPanelWidth}px minmax(0, 1fr)` }
      : { gridTemplateColumns: `minmax(0, 1fr) ${pinnedPanelWidth}px` }
    : undefined;
  const progressPercent = typeof status.progress === "number" && Number.isFinite(status.progress)
    ? Math.round(Math.min(1, Math.max(0, status.progress)) * 100)
    : 0;
  const canUndo = effectiveView === "editor" && Boolean(editActions?.canUndo);
  const canRedo = effectiveView === "editor" && Boolean(editActions?.canRedo);

  return (
    <div className="studio-shell" data-focus-mode={preferences.focusMode ? "on" : "off"} data-layout-ready={preferencesReady ? "true" : "false"} data-testid="studio-shell">
      <header className="studio-header" data-testid="studio-header">
        <div className="studio-brand" aria-label="PianoMotion Studio">
          <span className="studio-brand-mark" aria-hidden="true"><Piano size={18} strokeWidth={1.8} /></span>
          <span className="studio-brand-name">PianoMotion</span>
        </div>

        <div className="studio-menu-group studio-file-menu" ref={activeMenuRef}>
          <button
            type="button"
            className={`studio-header-button studio-menu-trigger ${menu === "file" ? "is-open" : ""}`}
            aria-label="File"
            aria-haspopup="menu"
            aria-expanded={menu === "file"}
            ref={fileMenuTriggerRef}
            onClick={() => toggleMenu("file")}
          ><span className="studio-file-label">File</span><ChevronDown size={14} />
          </button>
          {menu === "file" && (
            <div className="studio-menu-popover" role="menu" aria-label="File" onKeyDown={handleMenuKeyDown}>
              <span className="studio-menu-label">Project</span>
              <MenuItem icon={<FileUp />} onClick={() => chooseFromMenu(onOpenMidi)}>Open MIDI…</MenuItem>
              {onOpenBuiltinMelodies && <MenuItem icon={<FolderOpen />} onClick={() => chooseFromMenu(onOpenBuiltinMelodies)}>Built-in melodies…</MenuItem>}
              <MenuItem icon={<FolderOpen />} onClick={() => chooseFromMenu(onOpenPackage)}>Open project package…</MenuItem>
              <MenuItem icon={<FolderOpen />} onClick={() => chooseFromMenu(() => openPanel("projects", fileMenuTriggerRef.current ?? undefined))}>Open saved project…</MenuItem>
              <span className="studio-menu-divider" />
              <MenuItem icon={<Save />} disabled={!canSaveProject} onClick={() => onSave && chooseFromMenu(onSave)}>Save project</MenuItem>
            </div>
          )}
        </div>

        <div className="studio-menu-group studio-edit-menu" ref={menu === "edit" ? activeMenuRef : undefined}>
          <button
            type="button"
            className={`studio-header-button studio-menu-trigger ${menu === "edit" ? "is-open" : ""}`}
            aria-label="Edit"
            aria-haspopup="menu"
            aria-expanded={menu === "edit"}
            ref={editMenuTriggerRef}
            onClick={() => toggleMenu("edit")}
          ><span>Edit</span><ChevronDown size={14} />
          </button>
          {menu === "edit" && (
            <div className="studio-menu-popover studio-menu-edit" role="menu" aria-label="Edit" onKeyDown={handleMenuKeyDown}>
              <span className="studio-menu-label">History</span>
              <MenuItem icon={<Undo2 />} disabled={!canUndo} onClick={() => chooseFromMenu(() => editActions?.undo())}>
                Undo <kbd className="studio-menu-shortcut">Ctrl+Z</kbd>
              </MenuItem>
              <MenuItem icon={<Redo2 />} disabled={!canRedo} onClick={() => chooseFromMenu(() => editActions?.redo())}>
                Redo <kbd className="studio-menu-shortcut">Ctrl+Y</kbd>
              </MenuItem>
            </div>
          )}
        </div>

        <div className="studio-project-name" title={projectName || "Untitled project"}>
          <span className="studio-project-dot" data-has-project={hasProject ? "true" : "false"} aria-hidden="true" />
          <span>{projectName || "Untitled project"}</span>
        </div>

        <div className="studio-view-switch" role="group" aria-label="Workspace view">
          {viewOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={effectiveView === option.id}
              className={effectiveView === option.id ? "is-active" : ""}
              onClick={() => onViewModeChange(option.id)}
              title={`${option.label} view`}
            >{option.label}</button>
          ))}
        </div>

        {headerAddon && <div className="studio-header-addon" hidden={effectiveView !== "editor"}>{headerAddon}</div>}

        <div className="studio-header-spacer" />
        <div className="studio-save-state" data-kind={status.kind} aria-label={`Project status: ${status.message}`}>
          {status.kind === "saved" ? <CircleCheck size={15} />
            : status.kind === "error" ? <CircleAlert size={15} />
              : status.kind === "loading" || status.kind === "calculating" || status.kind === "saving"
                ? <LoaderCircle className="studio-spin" size={15} /> : <CircleDot size={15} />}
          <span>{status.kind === "saved" ? "Saved" : status.kind === "modified" ? "Modified" : status.kind === "saving" ? "Saving" : status.kind === "loading" ? "Loading" : status.kind === "calculating" ? "Calculating" : status.kind === "error" ? "Error" : "Ready"}</span>
        </div>

        <div className="studio-menu-group studio-export-menu" ref={menu === "export" ? activeMenuRef : undefined}>
          <button
            type="button"
            className={`studio-header-button studio-export-button ${menu === "export" ? "is-open" : ""}`}
            aria-label="Export"
            aria-haspopup="menu"
            aria-expanded={menu === "export"}
            ref={exportMenuTriggerRef}
            onClick={() => toggleMenu("export")}
          ><Download size={15} /><span>Export</span><ChevronDown size={14} />
          </button>
          {menu === "export" && (
            <div className="studio-menu-popover studio-menu-right" role="menu" aria-label="Export" onKeyDown={handleMenuKeyDown}>
              <span className="studio-menu-label">Export project</span>
              <MenuItem icon={<Activity />} disabled={!canExportProject || !onExportMidi} onClick={() => onExportMidi && chooseFromMenu(onExportMidi)}>Fingered MIDI (.mid)</MenuItem>
              <MenuItem icon={<Download />} disabled={!canExportProject || !onExportPackage} onClick={() => onExportPackage && chooseFromMenu(onExportPackage)}>Project package (.json)</MenuItem>
              <span className="studio-menu-divider" />
              <MenuItem
                icon={<Activity />}
                disabled={!canExportProject || !onExportVideo || Boolean(videoExportUnavailableReason)}
                onClick={() => onExportVideo && chooseFromMenu(onExportVideo)}
              >
                Performance video (.mp4 / .webm)
              </MenuItem>
              {videoExportUnavailableReason && <span id="studio-video-export-reason" className="studio-menu-label">{videoExportUnavailableReason}</span>}
            </div>
          )}
        </div>

        {onOpenPianist && <button className="studio-icon-button studio-pianist-button" type="button" onClick={onOpenPianist} aria-label="Open pianist settings" title="Pianist"><UserRound size={17} /></button>}
        <div className="studio-menu-group studio-help-menu" ref={menu === "help" ? activeMenuRef : undefined}>
          <button
            className={`studio-icon-button studio-help-button ${menu === "help" ? "is-open" : ""}`}
            type="button"
            onClick={() => toggleMenu("help")}
            aria-label="Help"
            aria-haspopup="menu"
            aria-expanded={menu === "help"}
            ref={helpMenuTriggerRef}
            title="Help"
          ><CircleHelp size={18} aria-hidden="true" /></button>
          {menu === "help" && (
            <div className="studio-menu-popover studio-menu-right" role="menu" aria-label="Help" onKeyDown={handleMenuKeyDown}>
              <span className="studio-menu-label">Help</span>
              <MenuItem icon={<Keyboard />} onClick={() => chooseFromMenu(() => setShortcutsOpen(true), false)}>
                Keyboard shortcuts
              </MenuItem>
            </div>
          )}
        </div>
        {onOpenPreferences && <button className="studio-icon-button studio-preferences-button" type="button" onClick={onOpenPreferences} aria-label="Open preferences" title="Preferences"><Settings2 size={17} /></button>}
      </header>

      <div className="studio-tool-rail" aria-label="Workspace panels">
        <button ref={(node) => { panelTriggersRef.current.projects = node; }} type="button" className={preferences.activePanel === "projects" ? "is-active" : ""} aria-pressed={preferences.activePanel === "projects"} onClick={(event) => openPanel("projects", event.currentTarget)} title="Projects" aria-label="Projects"><PanelLeft size={17} /><span>Projects</span></button>
        <button ref={(node) => { panelTriggersRef.current.inspector = node; }} type="button" className={preferences.activePanel === "inspector" ? "is-active" : ""} aria-pressed={preferences.activePanel === "inspector"} onClick={(event) => openPanel("inspector", event.currentTarget)} title="Inspector" aria-label="Inspector"><PanelRight size={17} /><span>Inspector</span></button>
        <button type="button" className={`studio-focus-toggle ${preferences.focusMode ? "is-active" : ""}`} aria-pressed={preferences.focusMode} onClick={toggleFocusMode} title={preferences.focusMode ? "Exit focus mode" : "Focus mode"} aria-label="Focus mode"><Activity size={17} /><span>Focus</span></button>
      </div>

      <main className="studio-main" data-testid="studio-main" style={mainStyle}>
        {shownDock && pinnedSide === "left" && (
          <StudioPanel side="left" title={shownDock === "projects" ? "Projects" : "Inspector"} pinned panel={shownDock} onClose={closePanel} onPin={setPanelPinned} resizeHandle={resizeHandle("left")}>
            {getPanelContent(shownDock)}
          </StudioPanel>
        )}
        <section className="studio-workspace" aria-label="Studio workspace">
          <div className={`studio-workspace-content view-${effectiveView}`} data-testid="studio-workspace-content">
            {workspaceContent}
          </div>
        </section>
        {shownDock && pinnedSide === "right" && (
          <StudioPanel side="right" title={shownDock === "projects" ? "Projects" : "Inspector"} pinned panel={shownDock} onClose={closePanel} onPin={setPanelPinned} resizeHandle={resizeHandle("right")}>
            {getPanelContent(shownDock)}
          </StudioPanel>
        )}
        {overlayPanel && (
          <StudioPanel
            side={overlaySide}
            title={overlayPanel === "projects" ? "Projects" : "Inspector"}
            pinned={preferences.pinnedSide === overlaySide}
            panel={overlayPanel}
            onClose={closePanel}
            onPin={setPanelPinned}
            resizeHandle={resizeHandle(overlaySide)}
            className="is-overlay"
            width={activeWidth}
          >{getPanelContent(overlayPanel)}</StudioPanel>
        )}
      </main>

      {mobilePanel && (
        <Dialog.Root open onOpenChange={(open) => { if (!open) closePanel(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="studio-sheet-overlay" />
            <Dialog.Content
              className="studio-mobile-sheet"
              data-testid={`${mobilePanel}-panel`}
              aria-describedby="studio-sheet-description"
              onOpenAutoFocus={(event) => {
                if (!responsiveSheetTransitionRef.current) return;
                responsiveSheetTransitionRef.current = false;
                event.preventDefault();
              }}
              onCloseAutoFocus={(event) => {
                if (responsiveSheetTransitionRef.current) {
                  responsiveSheetTransitionRef.current = false;
                  event.preventDefault();
                  return;
                }
                event.preventDefault();
                window.requestAnimationFrame(() => {
                  if (panelReturnFocusRef.current?.isConnected) panelReturnFocusRef.current.focus();
                });
              }}
            >
              <div className="studio-panel-heading">
                <div><Dialog.Title>{mobilePanel === "projects" ? "Projects" : "Inspector"}</Dialog.Title><Dialog.Description id="studio-sheet-description">Workspace panel</Dialog.Description></div>
                <button type="button" className="studio-panel-control" aria-label={`${preferences.pinnedSide === (mobilePanel === "projects" ? "left" : "right") ? "Unpin" : "Pin"} ${mobilePanel === "projects" ? "Projects" : "Inspector"} panel`} onClick={() => setPanelPinned(mobilePanel, mobilePanel === "projects" ? "left" : "right")}>{preferences.pinnedSide === (mobilePanel === "projects" ? "left" : "right") ? <PinOff size={15} /> : <Pin size={15} />}</button>
                <Dialog.Close className="studio-panel-control" aria-label="Close panel"><X size={17} /></Dialog.Close>
              </div>
              <div className="studio-panel-body">{getPanelContent(mobilePanel)}</div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {transport && <div className="studio-transport">{transport}</div>}
      <footer className="studio-statusbar" data-testid="studio-status">
        <StatusIcon kind={status.kind} />
        <button type="button" className="studio-status-message" title={status.message} aria-label={`Open diagnostics: ${status.message}`} onClick={openDiagnostics}>{status.message}</button>
        <span className="studio-sr-only" role="status" aria-live="polite" aria-atomic="true">{status.message}</span>
        {typeof status.progress === "number" && Number.isFinite(status.progress) && (status.kind === "loading" || status.kind === "calculating") && (
          <div className="studio-status-progress" role="progressbar" aria-label={status.details || status.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        )}
        {status.details && <button type="button" className="studio-status-details" title={status.details} aria-label={`Open diagnostics: ${status.details}`} onClick={openDiagnostics}>{status.details}</button>}
        {preferenceSaveError && <span className="studio-preference-warning" title="Layout preferences could not be saved locally">Layout not saved</span>}
        <span className="studio-status-spacer" />
        <span className="studio-status-label">{status.kind === "saved" ? "All changes saved" : status.kind === "modified" ? "Unsaved changes" : status.kind === "error" ? "Needs attention" : "PianoMotion Studio"}</span>
        {footerAddon && <div className="studio-footer-addon">{footerAddon}</div>}
      </footer>
      {dialogs && <div className="studio-fullscreen-screen">{dialogs}</div>}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        onReturnFocus={() => helpMenuTriggerRef.current?.focus({ preventScroll: true })}
      />
    </div>
  );
}

function MenuItem({
  icon,
  children,
  disabled = false,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="studio-menu-item" type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      <span className="studio-menu-item-icon" aria-hidden="true">{icon}</span><span>{children}</span>
    </button>
  );
}

function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  onReturnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnFocus: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="studio-shortcuts-overlay" />
        <Dialog.Content
          className="studio-shortcuts-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(onReturnFocus);
          }}
        >
          <div className="studio-shortcuts-dialog__heading">
            <Dialog.Title>Keyboard shortcuts</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="studio-icon-button" aria-label="Close keyboard shortcuts" title="Close">
                <X size={17} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="studio-shortcuts-dialog__description">
            Editing shortcuts work in Fingering mode. This help is available in both views.
          </Dialog.Description>
          <dl className="studio-shortcuts-list">
            {editorShortcuts.map((shortcut) => (
              <div key={shortcut.key} className="studio-shortcuts-list__row">
                <dt><kbd>{shortcut.key}</kbd></dt>
                <dd>{shortcut.description}</dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StudioPanel({
  side,
  title,
  pinned,
  panel,
  onClose,
  onPin,
  resizeHandle,
  className = "",
  width,
  children,
}: {
  side: ResizeSide;
  title: string;
  pinned: boolean;
  panel: PanelKind;
  onClose: () => void;
  onPin: (panel: PanelKind, side: ResizeSide) => void;
  resizeHandle: ReactNode;
  className?: string;
  width?: number;
  children: ReactNode;
}) {
  const style = width ? { width: `${width}px` } : undefined;
  return (
    <aside className={`studio-panel ${side === "left" ? "side-left" : "side-right"} ${className}`} style={style} aria-label={title} data-testid={`${panel}-panel`}>
      {side === "right" && resizeHandle}
      <div className="studio-panel-heading">
        <h2>{title}</h2>
        <div className="studio-panel-actions">
          <button type="button" className="studio-panel-control" aria-label={`${pinned ? "Unpin" : "Pin"} ${title} panel`} title={pinned ? "Unpin panel" : "Pin panel"} onClick={() => onPin(panel, side)}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
          <button type="button" className="studio-panel-control" aria-label="Close panel" title="Close panel" onClick={onClose}><X size={16} /></button>
        </div>
      </div>
      <div className="studio-panel-body">{children}</div>
      {side === "left" && resizeHandle}
    </aside>
  );
}

function StatusIcon({ kind }: { kind: StudioShellProps["status"]["kind"] }) {
  if (kind === "saved") return <Check size={13} aria-hidden="true" />;
  if (kind === "error") return <CircleAlert size={13} aria-hidden="true" />;
  if (kind === "loading" || kind === "calculating" || kind === "saving") return <LoaderCircle size={13} className="studio-spin" aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

export default StudioShell;

export interface StudioReleaseDetailsProps {
  version?: string;
  description?: string;
  children?: ReactNode;
}

/** Compact, nonmodal version disclosure for the fixed status bar. */
export function StudioReleaseDetails({
  version = studioPackageVersion,
  description = "Browser-based piano performance and fingering workspace.",
  children,
}: StudioReleaseDetailsProps) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef.current?.open || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      detailsRef.current.open = false;
      detailsRef.current.querySelector("summary")?.focus();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <details ref={detailsRef} className="studio-release-disclosure">
      <summary aria-label={`Release details, version ${version}`}>
        <span>v{version}</span><ChevronDown size={12} aria-hidden="true" />
      </summary>
      <div className="studio-release-popover" role="region" aria-label="Release details">
        <h2>Release details</h2>
        <strong>{version} · Audit remediation preview</strong>
        {description && <p>{description}</p>}
        {children}
      </div>
    </details>
  );
}
