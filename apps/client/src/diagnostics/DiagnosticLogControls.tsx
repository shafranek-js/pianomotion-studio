import { clearDiagnosticLog, downloadDiagnosticLog } from "./eventLog";
import styles from "../studio/StudioInspector.module.css";

export function DiagnosticLogControls() {
  return <div role="group" aria-label="Diagnostic log">
    <h3 className={styles.heading}>Diagnostic log</h3>
    <p className={styles.hint}>Recent local events survive reloads. Includes Worker timing, motion coverage and errors; excludes MIDI bytes and audio. Keeps up to 2,000 events within a bounded history.</p>
    <button className={styles.secondaryButton} type="button" onClick={downloadDiagnosticLog}>Download diagnostic log</button>
    <button className={styles.secondaryButton} type="button" onClick={clearDiagnosticLog}>Clear diagnostic log</button>
  </div>;
}
