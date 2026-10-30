/**
 * OSC 7501 program status encoding.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 *
 * Pi's `formatProgramStatus` (pi-tui) only encodes the root record, so this
 * module adds the `id`, `title`, and `progress` keys the spec defines for
 * child records.
 */

export type ProgramState =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "error"
  | "clear";

export type ProgramKind = "permission" | "question" | "auth";

export interface StatusReport {
  state: ProgramState;
  /** Absent or empty addresses the root record. */
  id?: string;
  app?: string;
  title?: string;
  msg?: string;
  kind?: ProgramKind;
  /** Integer 0-100; only with `working` or `blocked`. Absent means indeterminate. */
  progress?: number;
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_PATTERN = /^[A-Za-z0-9_.+-]{1,32}(\/[A-Za-z0-9_.+-]{1,32}){0,7}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the protocol forbids these characters in display text.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAX_ID_BYTES = 128;
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 2048;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function encodeText(value: string | undefined, maxBytes: number): string {
  const text = truncateUtf8(
    (value ?? "").replace(CONTROL_CHARACTERS, " ").trim(),
    maxBytes,
  );
  if (text.length === 0) return "";
  return Buffer.from(text, "utf8").toString("base64");
}

/** Encode one report. Returns null when the report has no usable state. */
export function formatStatusReport(report: StatusReport): string | null {
  const pairs = [`state=${report.state}`];

  if (report.id !== undefined && report.id !== "") {
    if (!ID_PATTERN.test(report.id)) return null;
    if (Buffer.byteLength(report.id, "utf8") > MAX_ID_BYTES) return null;
    pairs.push(`id=${report.id}`);
  }

  if (report.app !== undefined && APP_PATTERN.test(report.app)) {
    pairs.push(`app=${report.app}`);
  }

  if (report.state === "clear") {
    return `\x1b]7501;${pairs.join(":")}\x1b\\`;
  }

  if (report.state === "blocked" && report.kind) {
    pairs.push(`kind=${report.kind}`);
  }

  if (
    (report.state === "working" || report.state === "blocked") &&
    report.progress !== undefined
  ) {
    const progress = Math.max(0, Math.min(100, Math.round(report.progress)));
    pairs.push(`progress=${progress}`);
  }

  const title = encodeText(report.title, MAX_TITLE_BYTES);
  if (title) pairs.push(`title=${title}`);

  const msg = encodeText(report.msg, MAX_MSG_BYTES);
  if (msg) pairs.push(`msg=${msg}`);

  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
