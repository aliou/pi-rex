import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REX_ACTIVITY_END_EVENT,
  REX_ACTIVITY_SPAWN_EVENT,
  REX_ACTIVITY_UPDATE_EVENT,
  REX_BLOCKED_EVENT,
  REX_FOREGROUND_EVENT,
  REX_STATE_EVENT,
  type RexActivityEndPayload,
  type RexActivitySpawnPayload,
  type RexActivityUpdatePayload,
  type RexBlockedPayload,
  type RexForegroundPayload,
  type RexStatePayload,
} from "../../src/contract";
import type {
  ProgramKind,
  StatusReport,
} from "../../src/program-status/report";
import { ProgramStatusWriter } from "../../src/program-status/writer";
import { watchExternalEditor } from "./editor";

/**
 * Program status (OSC 7501) for pi.
 *
 * Pi reports its own root record (working, done, error, idle, built-in
 * dialogs), so this extension only writes namespaced child records; the root
 * stays pi's. Reports go to stdout, which is the same fd the TUI renders to;
 * the sequences are non-printing and do not disturb the TUI.
 *
 * Records:
 *
 *   agent                  the agent state machine: working, done, error, idle
 *   blocked/<source>       one record per blocked source: pi's own ui prompts
 *                          (ui_prompt_start) and contributor `rex:blocked` events
 *   activity/<id>          child work reported through `rex:activity:*` by
 *                          bridge extensions (subagents, processes, tasks)
 *
 * `done` and `error` records survive process exit, so shutdown forgets the
 * dedup state without clearing: the terminal keeps the final picture.
 */

const AGENT_ID = "agent";
const UI_PROMPT_SOURCE = "ui-prompt";

interface BlockedEntry {
  kind: ProgramKind;
  label: string;
}

interface ActivityEntry {
  title: string;
  app: string;
  report: StatusReport;
}

export default function programStatusExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let runActive = false;
  let currentTool: string | undefined;
  let sessionName: string | undefined;
  let errorText: string | undefined;
  let finishedText: string | undefined;
  const blocked = new Map<string, BlockedEntry>();
  const activity = new Map<string, ActivityEntry>();

  const writer = new ProgramStatusWriter((sequence) => {
    if (!enabled) return;
    if (!process.stdout.isTTY) return;
    if (process.env.PI_PROGRAM_STATUS === "0") return;
    process.stdout.write(sequence);
  });

  function emitState(state: RexStatePayload["state"]): void {
    const payload: RexStatePayload = { state };
    if (state === "working") payload.message = sessionName;
    pi.events.emit(REX_STATE_EVENT, payload);
  }

  function syncAgent(): void {
    if (!enabled) return;
    const title = sessionName ?? "pi";
    let report: StatusReport;
    if (runActive) {
      report = {
        state: "working",
        id: AGENT_ID,
        app: "pi",
        title,
        msg: currentTool,
      };
    } else if (errorText) {
      report = {
        state: "error",
        id: AGENT_ID,
        app: "pi",
        title,
        msg: errorText,
      };
    } else if (finishedText) {
      report = {
        state: "done",
        id: AGENT_ID,
        app: "pi",
        title,
        msg: finishedText,
      };
    } else {
      report = { state: "idle", id: AGENT_ID, app: "pi", title };
    }
    writer.report(report);
  }

  function syncBlocked(): void {
    if (!enabled) return;
    for (const [source, entry] of blocked) {
      writer.report({
        state: "blocked",
        kind: entry.kind,
        id: `blocked/${source}`,
        app: "pi",
        title: entry.label,
        msg: entry.label,
      });
    }
  }

  function setBlocked(source: string, entry: BlockedEntry | undefined): void {
    const previous = blocked.get(source);
    if (entry) {
      if (
        previous &&
        previous.kind === entry.kind &&
        previous.label === entry.label
      ) {
        return;
      }
      blocked.set(source, entry);
      syncBlocked();
      return;
    }
    if (!previous) return;
    blocked.delete(source);
    writer.clear(`blocked/${source}`);
  }

  function syncActivity(id: string): void {
    const entry = activity.get(id);
    if (!entry) return;
    writer.report({
      ...entry.report,
      id: `activity/${id}`,
      title: entry.title,
      app: entry.app,
    });
  }

  function firstLine(text: string | undefined): string | undefined {
    return text?.split(/\r?\n/, 1)[0]?.trim() || undefined;
  }

  /**
   * Rewrite the root record after pi writes it, dropping the session-name
   * message: pi also sets the window title to the session name, so rex
   * shows it twice. pi writes synchronously inside its subscriber, but the
   * session dispatch awaits between subscribers, so a microtask can land
   * before pi's write; setImmediate defers past the whole dispatch.
   * Dialog messages that carry real information (errors, "Compacting
   * context", login) are left alone.
   */
  function overrideRoot(): void {
    if (!enabled) return;
    setImmediate(() => {
      writer.report({ state: runActive ? "working" : "done", app: "pi" });
    });
  }

  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.mode === "tui" && process.stdout.isTTY === true;
    if (!enabled) return;
    sessionName = ctx.sessionManager.getSessionName();
    runActive = !ctx.isIdle();
    errorText = undefined;
    finishedText = undefined;
    currentTool = undefined;
    writer.reset();
    syncAgent();
    syncBlocked();
    for (const id of activity.keys()) syncActivity(id);
    emitState(runActive ? "working" : "idle");
  });

  pi.on("session_info_changed", (event) => {
    const renamed = event.name !== sessionName;
    sessionName = event.name;
    if (renamed) syncAgent();
    // pi rewrites the root report on every info change, named or not.
    overrideRoot();
  });

  pi.on("agent_start", () => {
    runActive = true;
    errorText = undefined;
    finishedText = undefined;
    currentTool = undefined;
    writer.clear("editor");
    syncAgent();
    emitState("working");
    overrideRoot();
  });

  pi.on("tool_execution_start", (event) => {
    currentTool = event.toolName;
    syncAgent();
  });

  pi.on("tool_execution_end", () => {
    currentTool = undefined;
    syncAgent();
  });

  pi.on("session_compact", () => {
    currentTool = "Compacting context";
    syncAgent();
  });

  pi.on("session_compact_failed", () => {
    currentTool = undefined;
    syncAgent();
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      errorText = firstLine(event.message.errorMessage) ?? "Error";
      return;
    }
    overrideRoot();
  });

  pi.on("agent_settled", (event) => {
    runActive = false;
    currentTool = undefined;
    if (event.aborted) {
      errorText = undefined;
      finishedText = undefined;
      // Pi reports idle without a message; nothing to rewrite.
      syncAgent();
      emitState("idle");
      return;
    }
    if (!errorText) {
      finishedText = "Finished";
      overrideRoot();
    }
    syncAgent();
    emitState(errorText ? "error" : "done");
  });

  // Pi starts waiting on a blocking extension UI prompt: ctx.ui select,
  // confirm, input, editor, and custom all come through here. A contributor
  // can claim the reserved ui-prompt slot first (its event fires before the
  // dialog opens) to replace the generic label with a real one; in that
  // case the generic report stays out of the way.
  pi.on("ui_prompt_start", (event) => {
    if (blocked.has(UI_PROMPT_SOURCE)) return;
    setBlocked(UI_PROMPT_SOURCE, {
      kind: "question",
      label: event.title ?? "Waiting for input",
    });
  });

  pi.on("ui_prompt_end", () => {
    setBlocked(UI_PROMPT_SOURCE, undefined);
  });

  const stopBlocked = pi.events.on(REX_BLOCKED_EVENT, (data) => {
    const payload = data as RexBlockedPayload | undefined;
    if (!payload?.source) return;
    setBlocked(
      payload.source,
      payload.active
        ? { kind: payload.kind, label: payload.label ?? "Waiting for you" }
        : undefined,
    );
  });

  const stopSpawn = pi.events.on(REX_ACTIVITY_SPAWN_EVENT, (data) => {
    const payload = data as RexActivitySpawnPayload | undefined;
    if (!payload?.id || !payload.title || activity.has(payload.id)) return;
    activity.set(payload.id, {
      title: payload.title,
      app: payload.app ?? "pi",
      report: { state: "working", app: "pi", msg: payload.msg },
    });
    syncActivity(payload.id);
  });

  const stopUpdate = pi.events.on(REX_ACTIVITY_UPDATE_EVENT, (data) => {
    const payload = data as RexActivityUpdatePayload | undefined;
    const entry = activity.get(payload?.id ?? "");
    if (!entry || !payload) return;
    const { state, kind, msg, progress, title, app } = payload;
    entry.report = {
      state,
      app: "pi",
      ...(state === "blocked" && kind ? { kind } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(msg !== undefined ? { msg } : {}),
    };
    if (title) entry.title = title;
    if (app) entry.app = app;
    syncActivity(payload.id);
  });

  const stopEnd = pi.events.on(REX_ACTIVITY_END_EVENT, (data) => {
    const payload = data as RexActivityEndPayload | undefined;
    const entry = activity.get(payload?.id ?? "");
    if (!entry || !payload) return;
    entry.report = {
      state: payload.state,
      app: "pi",
      ...(payload.msg !== undefined ? { msg: payload.msg } : {}),
    };
    if (payload.app) entry.app = payload.app;
    syncActivity(payload.id);
  });

  // An external program took the terminal foreground (ctrl+g opens $EDITOR,
  // ctrl+z suspends pi). Show it as a working child record: rex drops working
  // records when the foreground process exits, so the record disappears on
  // its own when the editor closes.
  const stopForeground = pi.events.on(REX_FOREGROUND_EVENT, (data) => {
    const payload = data as RexForegroundPayload | undefined;
    if (!payload) return;
    if (payload.name && !runActive) {
      writer.report({
        state: "working",
        id: "editor",
        app: "pi",
        title: "External editor",
        msg: payload.name,
      });
      return;
    }
    writer.clear("editor");
  });

  // Same signal where rex cannot see it: pi keeps the pty's foreground group
  // while $EDITOR runs, so watchExternalEditor reports the editor instead.
  const stopEditorWatch = watchExternalEditor((editor, app) => {
    if (editor && !runActive) {
      writer.report({
        state: "working",
        id: "editor",
        app,
        title: "External editor",
        msg: editor,
      });
      return;
    }
    writer.clear("editor");
  });

  pi.on("session_shutdown", () => {
    stopBlocked();
    stopSpawn();
    stopUpdate();
    stopEnd();
    stopForeground();
    stopEditorWatch();
    enabled = false;
    blocked.clear();
    activity.clear();
    // No clear: `done` and `error` records survive process exit by design.
    writer.reset();
  });
}
