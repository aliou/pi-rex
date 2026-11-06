/**
 * The pi-facing event contract. Other extensions emit these events; the
 * program-status extension renders them as OSC 7501 records. Bridges in
 * downstream packages (agent-kit, pi-processes) map their domain objects
 * onto these payloads.
 */

/** pi lifecycle state, emitted by the program-status extension on every change. */
export const PROGRAM_STATUS_STATE_EVENT = "program-status:state";

export interface ProgramStatusStatePayload {
  state: "working" | "idle" | "done" | "error";
  message?: string;
}

/**
 * An explicit block reported by a contributor extension. Pi already reports
 * its own dialogs and every `ctx.ui` prompt; use this for prompts that draw
 * outside those paths (external UIs, custom widgets with their own label or
 * kind).
 */
export const PROGRAM_STATUS_BLOCKED_EVENT = "program-status:blocked";

export interface ProgramStatusBlockedPayload {
  active: boolean;
  kind: "permission" | "question" | "auth";
  label?: string;
  /**
   * Stable id for the contributor; each source gets its own child record.
   * `ui-prompt` is reserved: that record is normally the program-status
   * extension's generic report for pi's own `ui_prompt_start` ("Waiting for
   * input"). Emitting with this source replaces the generic label with a real
   * one, and the extension skips the generic report when a contributor
   * claimed the slot before the dialog opened. Clear it when the prompt
   * resolves.
   */
  source: string;
}

/** A child record appears: a subagent, a process, a long-running task. */
export const PROGRAM_STATUS_ACTIVITY_SPAWN_EVENT =
  "program-status:activity:spawn";

export interface ProgramStatusActivitySpawnPayload {
  /** Stable id; the record lives at `activity/<id>`. */
  id: string;
  title: string;
  msg?: string;
  /** Program the record belongs to; defaults to pi. Selects the terminal's icon. */
  app?: string;
}

/** Progress or a new message for an existing child record. */
export const PROGRAM_STATUS_ACTIVITY_UPDATE_EVENT =
  "program-status:activity:update";

export interface ProgramStatusActivityUpdatePayload {
  id: string;
  state: "working" | "blocked";
  kind?: "permission" | "question" | "auth";
  msg?: string;
  progress?: number;
  title?: string;
  app?: string;
}

/** A child record finished. */
export const PROGRAM_STATUS_ACTIVITY_END_EVENT = "program-status:activity:end";

export interface ProgramStatusActivityEndPayload {
  id: string;
  state: "done" | "error";
  msg?: string;
  app?: string;
}
