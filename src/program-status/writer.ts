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

  /** Send one report if it changed since the last send. Leaves every other record alone. */
  report(report: StatusReport): void {
    const sequence = formatStatusReport(report);
    if (!sequence) return;
    const id = report.id ?? "";
    if (this.lastSent.get(id) === sequence) return;
    this.lastSent.set(id, sequence);
    this.write(sequence);
  }

  /** Remove one record and every record beneath it. */
  clear(id: string): void {
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
    if (wasPresent) this.write(sequence);
  }

  /** Forget every record without writing anything (used on shutdown). */
  reset(): void {
    this.lastSent.clear();
  }
}
