/**
 * The pi-facing event contract. Other extensions emit the `rex:*` events
 * here; the pi-rex extensions render them as OSC 7501 records or rex
 * terminal events. Bridges in downstream packages (agent-kit, pi-processes)
 * map their domain objects onto these payloads.
 */

/** pi lifecycle state, emitted by the program-status extension on every change. */
export const REX_STATE_EVENT = "rex:state";

export interface RexStatePayload {
  state: "working" | "idle" | "done" | "error";
  message?: string;
}

/**
 * An explicit block reported by a contributor extension. Pi already reports
 * its own dialogs and every `ctx.ui` prompt; use this for prompts that draw
 * outside those paths (external UIs, custom widgets with their own label or
 * kind).
 */
export const REX_BLOCKED_EVENT = "rex:blocked";

export interface RexBlockedPayload {
  active: boolean;
  kind: "permission" | "question" | "auth";
  label?: string;
  /**
   * Stable id for the contributor; each source gets its own child record.
   * `ui-prompt` is reserved: that record is normally pi-rex's generic report
   * for pi's own `ui_prompt_start` ("Waiting for input"). Emitting with this
   * source replaces the generic label with a real one, and pi-rex skips the
   * generic report when a contributor claimed the slot before the dialog
   * opened. Clear it when the prompt resolves.
   */
  source: string;
}

/** A child record appears: a subagent, a process, a long-running task. */
export const REX_ACTIVITY_SPAWN_EVENT = "rex:activity:spawn";

export interface RexActivitySpawnPayload {
  /** Stable id; the record lives at `activity/<id>`. */
  id: string;
  title: string;
  msg?: string;
  /** Program the record belongs to; defaults to pi. Drives the rex icon. */
  app?: string;
}

/** Progress or a new message for an existing child record. */
export const REX_ACTIVITY_UPDATE_EVENT = "rex:activity:update";

export interface RexActivityUpdatePayload {
  id: string;
  state: "working" | "blocked";
  kind?: "permission" | "question" | "auth";
  msg?: string;
  progress?: number;
  title?: string;
  app?: string;
}

/** A child record finished. */
export const REX_ACTIVITY_END_EVENT = "rex:activity:end";

export interface RexActivityEndPayload {
  id: string;
  state: "done" | "error";
  msg?: string;
  app?: string;
}

/** Register a matcher over rex terminal events. */
export const REX_REGISTER_MATCHER_EVENT = "rex:register-matcher";

export interface RexMatcherEvent {
  /** The terminal event name without the creator prefix, e.g. `program_status_changed`. */
  name: string;
  blockId: string | undefined;
  payload: unknown;
}

export interface RexRegisterMatcherPayload {
  /** Unique per registration; re-registering replaces. */
  name: string;
  match: (event: RexMatcherEvent) => boolean;
  reply: (accepted: boolean) => void;
}

export const REX_UNREGISTER_MATCHER_EVENT = "rex:unregister-matcher";

export interface RexUnregisterMatcherPayload {
  name: string;
}

/** A rex terminal event matched a registered matcher. */
export const REX_TERMINAL_EVENT = "rex:terminal-event";

export interface RexTerminalEventPayload {
  /** The matcher that matched. */
  matcher: string;
  event: RexMatcherEvent;
}

/**
 * The foreground process of this block changed. Emitted by the rex
 * extension only for the block pi runs in. Pi in the foreground emits a
 * payload with `name: undefined`.
 */
export const REX_FOREGROUND_EVENT = "rex:foreground";

export interface RexForegroundPayload {
  name: string | undefined;
  pid: number | undefined;
}
