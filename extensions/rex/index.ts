import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rexExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.notify("pi-rex loaded", "info");
  });
}
