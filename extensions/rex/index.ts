import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REX_FOREGROUND_EVENT,
  REX_REGISTER_MATCHER_EVENT,
  REX_TERMINAL_EVENT,
  REX_UNREGISTER_MATCHER_EVENT,
  type RexForegroundPayload,
  type RexMatcherEvent,
  type RexRegisterMatcherPayload,
  type RexTerminalEventPayload,
  type RexUnregisterMatcherPayload,
} from "../../src/contract";
import { RexControlClient } from "../../src/rex/control";
import { defaultSocketPath, readRexEnv } from "../../src/rex/env";
import { unwrapBlockEvent } from "../../src/rex/events";
import { createSocketConnector } from "../../src/rex/ws-connector";

/**
 * The rex side of pi-rex: a control-socket connection to the rex server and
 * a matcher registry over its event stream.
 *
 * When the process runs inside rex (REX_SESSION present), the extension
 * attaches to the session and receives every terminal event: program status
 * changes, process exits, foreground changes, for every block in the
 * session. Other extensions register matchers with `rex:register-matcher`
 * and receive the events they match as `rex:terminal-event`.
 *
 * Outside rex the extension stays dormant; matcher registrations are
 * rejected so callers can fall back.
 */

export default function rexExtension(pi: ExtensionAPI): void {
  const matchers = new Map<string, (event: RexMatcherEvent) => boolean>();
  let client: RexControlClient | undefined;

  const stopRegister = pi.events.on(REX_REGISTER_MATCHER_EVENT, (data) => {
    const payload = data as RexRegisterMatcherPayload | undefined;
    if (
      !payload ||
      typeof payload.name !== "string" ||
      typeof payload.match !== "function"
    ) {
      payload?.reply?.(false);
      return;
    }
    matchers.set(payload.name, payload.match);
    payload.reply?.(true);
  });

  const stopUnregister = pi.events.on(REX_UNREGISTER_MATCHER_EVENT, (data) => {
    const payload = data as RexUnregisterMatcherPayload | undefined;
    if (payload?.name) matchers.delete(payload.name);
  });

  function dispatch(event: RexMatcherEvent): void {
    for (const [name, match] of matchers) {
      let matched = false;
      try {
        matched = match(event);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      const payload: RexTerminalEventPayload = { matcher: name, event };
      pi.events.emit(REX_TERMINAL_EVENT, payload);
    }
  }

  async function connect(
    sessionId: string,
    blockId: string,
    socketPath: string,
  ): Promise<void> {
    const control = new RexControlClient(createSocketConnector(socketPath), {
      clientName: "pi-rex",
      onEvent: (serverEvent) => {
        const event = unwrapBlockEvent(serverEvent);
        if (!event) return;
        // Internal watcher: report this block's foreground process changes
        // (an external editor, a suspended pi) as a contract event.
        if (event.blockId === blockId && event.name === "process_changed") {
          const foreground = (
            event.payload as {
              foreground?: { name?: string; pid?: number } | null;
            }
          )?.foreground;
          const payload: RexForegroundPayload = {
            name: foreground?.name,
            pid: foreground?.pid,
          };
          pi.events.emit(REX_FOREGROUND_EVENT, payload);
          return;
        }
        dispatch(event);
      },
    });
    try {
      await control.start();
      await control.attach(sessionId);
    } catch (err) {
      control.close();
      throw err;
    }
    client = control;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const rexEnv = readRexEnv(process.env);
    if (!rexEnv.sessionId) return;
    const socketPath = defaultSocketPath(process.env);
    if (!socketPath) return;
    void connect(rexEnv.sessionId, rexEnv.blockId ?? "", socketPath).catch(
      () => {
        // No rex server, or a version that rejects us: the extension stays
        // dormant and matcher registrations keep succeeding but never match.
        client = undefined;
      },
    );
  });

  pi.on("session_shutdown", () => {
    stopRegister();
    stopUnregister();
    matchers.clear();
    client?.close();
    client = undefined;
  });
}
