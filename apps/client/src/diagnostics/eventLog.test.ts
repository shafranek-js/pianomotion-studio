import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticJournal, diagnosticLogContents, flushDiagnosticLog, initializeDiagnosticLog, recordDiagnostic } from "./eventLog";

afterEach(() => vi.unstubAllGlobals());

describe("local diagnostic journal", () => {
  it("keeps correlation identity, chronology, errors and prior sessions after reload", () => {
    let time = Date.UTC(2026, 9, 16);
    const journal = new DiagnosticJournal("before-reload", () => time);
    journal.record("worker.request", { projectId: "p", revision: 4, requestId: "r", start: 8.75, end: 12.75 });
    time += 120;
    journal.record("motion.error", { requestId: "r", error: new Error("incomplete window") }, "error");
    const restored = new DiagnosticJournal("after-reload", () => time);
    restored.restore(journal.serialize());
    restored.record("session.started");
    const events = restored.snapshot();
    expect(events.map(e => e.sessionId)).toEqual(["before-reload", "before-reload", "after-reload"]);
    expect(events[0]!.details).toMatchObject({ projectId: "p", revision: 4, requestId: "r" });
    expect(events[1]).toMatchObject({ elapsedMs: 120, level: "error", details: { error: { message: "incomplete window" } } });
  });
  it("bounds events and serialized size while retaining the newest evidence", () => {
    const journal = new DiagnosticJournal("bounded", () => 0, 4, 1_000);
    for (let i = 0; i < 100; i++) journal.record("worker.result", { requestId: String(i), message: "x".repeat(100) });
    expect(journal.snapshot().length).toBeLessThanOrEqual(4);
    expect(journal.serialize().length).toBeLessThanOrEqual(1_000);
    expect(journal.snapshot().at(-1)!.details).toMatchObject({ requestId: "99" });
  });
  it("omits musical binary payloads and tolerates cyclic or corrupt diagnostic data", () => {
    const journal = new DiagnosticJournal("safe", () => 0);
    const details: Record<string, unknown> = { midiBytes: new Uint8Array([1, 2]), poses: ["large"], otherBytes: new Uint8Array([3]), message: "failure" };
    details.cycle = details;
    journal.record("worker.error", details);
    expect(journal.snapshot()[0]!.details).toEqual({ otherBytes: "[binary omitted]", message: "failure", cycle: "[circular]" });
    journal.restore("not json");
    journal.restore('[{"unrelated":"garbage"}]');
    expect(journal.snapshot()).toHaveLength(1);
    const snapshot = journal.snapshot();
    snapshot[0]!.event = "mutated outside";
    expect(journal.snapshot()[0]!.event).toBe("worker.error");
    journal.clear();
    expect(journal.snapshot()).toEqual([]);
  });
  it("keeps an exportable memory log when browser persistence fails", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); } }, addEventListener: vi.fn() });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("navigator", { userAgent: "diagnostic-test", onLine: true });
    vi.stubGlobal("location", { pathname: "/" });
    expect(() => initializeDiagnosticLog()).not.toThrow();
    expect(() => recordDiagnostic("test.storage-error", { code: "quota" }, "error")).not.toThrow();
    expect(() => flushDiagnosticLog()).not.toThrow();
    const exported = JSON.parse(diagnosticLogContents());
    expect(exported.events).toContainEqual(expect.objectContaining({ event: "test.storage-error", details: { code: "quota" } }));
  });
});
