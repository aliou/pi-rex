import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REX_ACTIVITY_END_EVENT,
  REX_ACTIVITY_SPAWN_EVENT,
  REX_ACTIVITY_UPDATE_EVENT,
} from "../../src/contract";

/**
 * Demo scaffold: drives pi-rex activity records from a JSON timeline so a
 * recording can show subagent-style workers without a second agent.
 *
 * PI_REX_SHOWCASE points at a config file:
 *
 *   {
 *     "workers": [
 *       { "on": "start",                          ... spawn when the session starts },
 *       { "on": "first_tool",                     ... spawn on the first tool call },
 *       { "on": "tool", "toolName": "bash", "minToolCalls": 2, ... }
 *     ]
 *   }
 *
 * Each worker: { id, title, startMsg, durationMs, doneMsg }. It reports
 * working with progress climbing to 90, then ends done. Every step is
 * traced to PI_REX_SHOWCASE_LOG (default /tmp/pi-rex-showcase.jsonl).
 */

interface WorkerConfig {
  on: "start" | "first_tool" | "tool";
  toolName?: string;
  minToolCalls?: number;
  id: string;
  title: string;
  startMsg?: string;
  durationMs?: number;
  doneMsg?: string;
  /** Set when the worker should end failed instead of done. */
  errorMsg?: string;
  /** Mid-run block: the worker goes blocked, then resumes working. */
  blocked?: {
    atMs: number;
    forMs: number;
    kind: "permission" | "question" | "auth";
    msg: string;
  };
  /** App key; picks the terminal's glyph. Defaults to pi. */
  app?: string;
}

interface ShowcaseConfig {
  workers: WorkerConfig[];
}

const LOG_PATH =
  process.env.PI_REX_SHOWCASE_LOG ?? "/tmp/pi-rex-showcase.jsonl";

function trace(step: string, data: unknown): void {
  try {
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ t: new Date().toISOString(), step, data })}\n`,
    );
  } catch {
    return; // Tracing must never break the demo.
  }
}

function loadConfig(): ShowcaseConfig {
  const path = process.env.PI_REX_SHOWCASE;
  if (!path) return { workers: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ShowcaseConfig;
  } catch {
    return { workers: [] };
  }
}

export default function showcaseExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const spawned = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let toolCalls = 0;

  function runWorker(worker: WorkerConfig): void {
    if (spawned.has(worker.id)) return;
    spawned.add(worker.id);
    pi.events.emit(REX_ACTIVITY_SPAWN_EVENT, {
      id: worker.id,
      title: worker.title,
      msg: worker.startMsg,
      app: worker.app,
    });
    trace("spawn", worker);

    const durationMs = worker.durationMs ?? 10000;
    const startedAt = Date.now();
    let blocked = false;
    const interval = setInterval(() => {
      if (blocked) return;
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(90, Math.round((elapsed / durationMs) * 90));
      pi.events.emit(REX_ACTIVITY_UPDATE_EVENT, {
        id: worker.id,
        state: "working",
        progress,
      });
    }, 1000);
    intervals.push(interval);

    const at = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(fn, ms));
    };

    if (worker.blocked) {
      const { atMs, forMs, kind, msg } = worker.blocked;
      at(atMs, () => {
        blocked = true;
        pi.events.emit(REX_ACTIVITY_UPDATE_EVENT, {
          id: worker.id,
          state: "blocked",
          kind,
          msg,
        });
        trace("blocked", worker);
      });
      at(atMs + forMs, () => {
        blocked = false;
        pi.events.emit(REX_ACTIVITY_UPDATE_EVENT, {
          id: worker.id,
          state: "working",
        });
        trace("resumed", worker);
      });
    }

    at(durationMs, () => {
      clearInterval(interval);
      pi.events.emit(REX_ACTIVITY_END_EVENT, {
        id: worker.id,
        state: worker.errorMsg ? "error" : "done",
        msg: worker.errorMsg ?? worker.doneMsg,
        app: worker.app,
      });
      trace("end", { id: worker.id, error: Boolean(worker.errorMsg) });
    });
  }

  function checkToolWorkers(toolName: string): void {
    for (const worker of config.workers) {
      if (worker.on === "first_tool" && toolCalls === 1) {
        runWorker(worker);
      }
      if (worker.on === "tool" && worker.toolName === toolName) {
        const min = worker.minToolCalls ?? 1;
        if (toolCalls >= min && toolCalls < min + 1) runWorker(worker);
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    trace("session_start", { workers: config.workers.length });
    for (const worker of config.workers) {
      if (worker.on === "start") runWorker(worker);
    }
  });

  pi.on("tool_execution_start", (event) => {
    toolCalls += 1;
    trace("tool", { toolName: event.toolName, count: toolCalls });
    checkToolWorkers(event.toolName);
  });

  pi.on("session_shutdown", () => {
    for (const timer of timers) clearTimeout(timer);
    for (const interval of intervals) clearInterval(interval);
    timers.length = 0;
    intervals.length = 0;
    trace("shutdown", {});
  });
}
