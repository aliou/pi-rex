import { formatStatusReport, type StatusReport } from "./report";

/**
 * Sends OSC 7501 reports to a terminal, deduplicating per record id: a report
 * replaces its record completely, so re-sending an identical record only
 * churns the terminal.
 *
 * The write function is injected: this module never touches process.stdout,
 * so callers choose the destination (a TTY, a test sink, a pty).
 */
export class ProgramStatusWriter {
  private readonly lastSent = new Map<string, string>();
  private readonly write: (sequence: string) => void;

  constructor(write: (sequence: string) => void) {
    this.write = write;
  }

  /** Send the reports that changed, and clear the records that disappeared. */
  update(reports: StatusReport[]): void {
    const desired = new Map<string, string>();
    for (const report of reports) {
      const sequence = formatStatusReport(report);
      if (sequence) desired.set(report.id ?? "", sequence);
    }

    for (const [id, sequence] of desired) {
      if (this.lastSent.get(id) === sequence) continue;
      this.lastSent.set(id, sequence);
      this.write(sequence);
    }

    for (const id of [...this.lastSent.keys()]) {
      if (desired.has(id)) continue;
      this.clear(id);
    }
  }

  /**
   * Send one report if it changed since the last send. Leaves every other
   * record alone. force skips the dedupe check: use it when something else
   * may have replaced the record with content identical to the last send,
   * so the terminal no longer holds what lastSent describes.
   */
  report(report: StatusReport, force = false): void {
    const sequence = formatStatusReport(report);
    if (!sequence) return;
    const id = report.id ?? "";
    if (!force && this.lastSent.get(id) === sequence) return;
    this.lastSent.set(id, sequence);
    this.write(sequence);
  }

  /**
   * Remove one record and every record beneath it. Skips the write when the
   * writer never sent the record, unless force is set: a fresh writer (new
   * process, reload) has an empty history but the terminal may still hold
   * records a previous incarnation left behind.
   */
  clear(id: string, force = false): void {
    const sequence = formatStatusReport(
      id === "" ? { state: "clear" } : { state: "clear", id },
    );
    if (!sequence) return;
    const prefix = id === "" ? "" : `${id}/`;
    let wasPresent = false;
    for (const key of [...this.lastSent.keys()]) {
      if (key === id || key.startsWith(prefix)) {
        this.lastSent.delete(key);
        wasPresent = true;
      }
    }
    if (!wasPresent && !force) return;
    this.write(sequence);
  }

  /** Forget every record without writing anything (used on shutdown). */
  reset(): void {
    this.lastSent.clear();
  }
}
