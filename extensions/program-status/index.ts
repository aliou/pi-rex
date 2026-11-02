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
 * The agent state lives on the root record, so a plain pi session renders as
 * a single status entry; child records are only for work beside the agent.
 * Pi owns the root too and writes it on the same events — with the session
 * name as the message, which the window title already shows — so this
 * extension re-asserts the root after each of pi's writes. Reports go to
 * stdout, which is the same fd the TUI renders to; the sequences are
 * non-printing and do not disturb the TUI.
 *
 * Records:
 *
 *   root                   the agent state machine: working (msg = current
 *                          tool), done ("Finished"), error (first error
 *                          line), idle
 *   blocked/<source>       one record per blocked source: pi's own ui prompts
 *                          (ui_prompt_start) and contributor `rex:blocked` events
 *   activity/<id>          child work reported through `rex:activity:*` by
 *                          bridge extensions (subagents, processes, tasks)
 *
 * `done` and `error` records survive process exit, so shutdown forgets the
 * dedup state without clearing: the terminal keeps the final picture.
 */

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

  function agentReport(): StatusReport {
    if (runActive) {
      return currentTool
        ? { state: "working", app: "pi", msg: currentTool }
        : { state: "working", app: "pi" };
    }
    if (errorText) return { state: "error", app: "pi", msg: errorText };
    if (finishedText) return { state: "done", app: "pi", msg: finishedText };
    return { state: "idle", app: "pi" };
  }

  /**
   * Assert the agent state onto the root record. Pi writes the root
   * synchronously inside its subscriber, so the assert defers past the whole
   * dispatch: the session dispatch awaits between subscribers, so a
   * setImmediate lands after pi's write. Events where pi also writes the
   * root pass force=true — pi's write can replace our record with a sequence
   * the writer would otherwise dedupe away, leaving pi's session-name
   * message (already shown by the window title) on the root.
   */
  function syncAgent(force = false): void {
    if (!enabled) return;
    const report = agentReport();
    setImmediate(() => writer.report(report, force));
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

  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.mode === "tui" && process.stdout.isTTY === true;
    if (!enabled) return;
    sessionName = ctx.sessionManager.getSessionName();
    runActive = !ctx.isIdle();
    errorText = undefined;
    finishedText = undefined;
    currentTool = undefined;
    writer.reset();
    // A previous process (or reload) can leave the editor record behind: it
    // is cleared on foreground changes, not on exit, and pi suspends while
    // an editor runs, so a live record here is always stale. The writer is
    // fresh, so force the clear past its history check.
    writer.clear("editor", true);
    syncAgent();
    syncBlocked();
    for (const id of activity.keys()) syncActivity(id);
    emitState(runActive ? "working" : "idle");
  });

  pi.on("session_info_changed", (event) => {
    sessionName = event.name;
    // pi rewrites the root report on every info change, named or not.
    syncAgent(true);
  });

  pi.on("agent_start", () => {
    runActive = true;
    errorText = undefined;
    finishedText = undefined;
    currentTool = undefined;
    writer.clear("editor");
    syncAgent(true);
    emitState("working");
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
    syncAgent(true);
  });

  pi.on("session_compact_failed", () => {
    currentTool = undefined;
    syncAgent(true);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error") {
      errorText = firstLine(event.message.errorMessage) ?? "Error";
      return;
    }
    syncAgent(true);
  });

  pi.on("agent_settled", (event) => {
    runActive = false;
    currentTool = undefined;
    if (event.aborted) {
      errorText = undefined;
      finishedText = undefined;
    } else if (!errorText) {
      finishedText = "Finished";
    }
    // pi reports the settled state on the root; re-assert our message past it.
    syncAgent(true);
    emitState(event.aborted ? "idle" : errorText ? "error" : "done");
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
    // pi rewrites the root when the dialog closes (working + session name,
    // or the resting state); re-assert the agent's message past it.
    syncAgent(true);
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
  //
  // Pi itself is node, and process_changed fires when a finished tool's shell
  // hands the foreground back to it — often right after agent_settled, so
  // runActive is already false. Treating that as an editor used to write a
  // working record that nothing ever cleared: the foreground stays pi, so no
  // later event reaches the clear branch, and rex keeps the record while pi
  // lives. Report only a foreground process we can tell isn't pi.
  const stopForeground = pi.events.on(REX_FOREGROUND_EVENT, (data) => {
    const payload = data as RexForegroundPayload | undefined;
    if (!payload) return;
    if (
      payload.name &&
      payload.pid &&
      payload.pid !== process.pid &&
      !runActive
    ) {
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
