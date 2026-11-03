declare module "opensheetmusicdisplay" {
  export interface IOSMDOptions {
    backend?: "svg" | "canvas";
    drawingParameters?: "default" | "compact" | "compacttight" | "preview" | "thumbnail";
    drawCredits?: boolean;
    drawTitle?: boolean;
    drawSubtitle?: boolean;
    drawComposer?: boolean;
    drawLyricist?: boolean;
    drawMetronomeMarks?: boolean;
    drawPartNames?: boolean;
    drawPartAbbreviations?: boolean;
    drawMeasureNumbers?: boolean;
    drawLyrics?: boolean;
    drawFingerings?: boolean;
    fingeringPosition?: "above" | "below" | "aboveorbelow" | "left" | "right" | "auto";
    autoResize?: boolean;
    followCursor?: boolean;
    renderSingleHorizontalStaffline?: boolean;
  }

  export interface EngravingRules {
    SheetMaximumWidth: number;
    PageTopMargin: number;
    PageBottomMargin: number;
    PageLeftMargin: number;
    PageRightMargin: number;
    StaffLineWidth: number;
    StaffLineColor: string;
    LedgerLineWidth: number;
    LedgerLineColorDefault: string;
    SystemThinLineWidth: number;
  }

  export interface SourceTimestamp {
    readonly RealValue: number;
  }

  export interface MusicPartManagerIterator {
    readonly EndReached: boolean;
    readonly CurrentSourceTimestamp?: SourceTimestamp;
  }

  export interface Cursor {
    readonly cursorElement: HTMLImageElement;
    readonly Iterator: MusicPartManagerIterator;
    show(): void;
    hide(): void;
    reset(): void;
    next(): void;
  }

  export class OpenSheetMusicDisplay {
    constructor(container: HTMLElement | string, options?: IOSMDOptions);
    readonly EngravingRules: EngravingRules;
    Zoom: number;
    readonly cursor: Cursor;
    load(content: string | Document): Promise<void>;
    render(): void;
    clear(): void;
  }
}
