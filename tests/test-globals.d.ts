import type { M1AnalyzeMidiResult } from "@handthesia/contracts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

declare global {
  interface Window {
    // Browser tests read the player's diagnostic snapshot.
    __playerSnapshot?: { result: M1AnalyzeMidiResult; [key: string]: any };
    __m1LastResult?: M1AnalyzeMidiResult | null;
    __m1LastError?: string | null;
  }
}
