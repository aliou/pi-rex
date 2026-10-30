import { execFile } from "node:child_process";
import { basename } from "node:path";

/**
 * Detecting the external editor pi opens with ctrl+g.
 *
 * pi spawns the editor with stdio inherit and no job control, so the pty's
 * foreground process group stays with pi: rex never sees a foreground or
 * process change, and pi emits no event. What pi does do is print
 * "Launching external editor: <command>" to stdout, so this module watches
 * stdout for that marker and reports the editor until its process is gone
 * from pi's children.
 *
 * The stdout writer is restored by the returned stop function.
 */

/**
 * Map an editor command to the app key rex has a glyph for, when one exists.
 */
const EDITOR_APPS: Record<string, string> = {
  nvim: "neovim",
  vim: "vim",
  hx: "hx",
  emacs: "emacs",
  emacsclient: "emacs",
};

const LAUNCH_MARKER =
  /Launching external editor: (.+)\nPi will resume when the editor exits/;
const POLL_INTERVAL_MS = 1000;

export function watchExternalEditor(
  onChange: (editor: string, app: string) => void,
): () => void {
  const original = process.stdout.write.bind(process.stdout);
  let polling: ReturnType<typeof setInterval> | undefined;

  function stopPolling(): void {
    if (!polling) return;
    clearInterval(polling);
    polling = undefined;
  }

  function pollUntilGone(editor: string): void {
    stopPolling();
    polling = setInterval(() => {
      execFile(
        "pgrep",
        ["-l", "-P", String(process.pid), editor],
        (err, stdout) => {
          const running =
            !err && stdout.split("\n").some((line) => line.trim() !== "");
          if (running) return;
          stopPolling();
          onChange("", "pi");
        },
      );
    }, POLL_INTERVAL_MS);
    polling.unref?.();
  }

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      // Match pi's full two-line marker: rendered model text can quote the
      // first line alone, so a bare substring match reports phantom editors.
      const match = LAUNCH_MARKER.exec(String(chunk));
      if (match) {
        const command = match[1].trim().split(" ")[0] ?? "";
        const editor = command ? basename(command) : undefined;
        if (editor) {
          onChange(editor, EDITOR_APPS[editor] ?? "pi");
          pollUntilGone(editor);
        }
      }
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  return () => {
    stopPolling();
    process.stdout.write = original;
  };
}
