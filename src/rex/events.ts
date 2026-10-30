/**
 * Typed views over rex terminal events as they arrive on the control
 * connection. A terminal event is wrapped twice on the wire:
 *
 *   { type: "event", payload: { seq, payload: {
 *       type: "session_event", payload: { session_id, event: {
 *         type: "block_event", payload: { block_id, creator_name, name, payload } } } } } }
 */

export type RexEventName =
  | "child_exited"
  | "pwd_changed"
  | "title_changed"
  | "bell"
  | "process_changed"
  | "desktop_notification"
  | "progress_report"
  | "clipboard_written"
  | "program_status_changed"
  | "program_status_removed"
  | (string & {});

export interface RexProgramStatusRecord {
  state: string;
  app?: string;
  effective_app?: string;
  id?: string;
  kind?: string;
  msg?: string;
  progress?: number;
  updated_at?: string;
  owner?: { pid: number; name: string };
}

export interface RexMatcherEvent {
  /** Terminal event name without the creator prefix, e.g. `program_status_changed`. */
  name: RexEventName;
  blockId: string | undefined;
  payload: unknown;
}

interface BlockEventFrame {
  type?: string;
  payload?: {
    session_id?: string;
    event?: {
      type?: string;
      payload?: {
        block_id?: string;
        creator_name?: string;
        name?: string;
        payload?: unknown;
      };
    };
  };
}

/** Unwrap a server event frame down to terminal events; null when it is not one. */
export function unwrapBlockEvent(serverEvent: {
  payload: unknown;
}): RexMatcherEvent | null {
  const frame = serverEvent.payload as BlockEventFrame | undefined;
  const event = frame?.payload?.event;
  if (event?.type !== "block_event") return null;
  if (event.payload?.creator_name !== "com.superlogical.terminal") return null;
  return {
    name: event.payload.name ?? "",
    blockId: event.payload.block_id,
    payload: event.payload.payload,
  };
}
