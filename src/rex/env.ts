/**
 * Detecting Rex from the environment a pi process runs in.
 *
 * Rex sets `REX_SESSION` (and `REX_BLOCK`) for programs it starts, and
 * `TERM_PROGRAM=rex`.
 */

export interface RexEnv {
  /** `session:<uuid>`, present only inside Rex. */
  sessionId: string | undefined;
  /** `block:<uuid>`, the pane the program runs in. */
  blockId: string | undefined;
}

export function readRexEnv(env: NodeJS.ProcessEnv): RexEnv {
  const sessionId = env.REX_SESSION;
  const blockId = env.REX_BLOCK;
  return {
    sessionId: sessionId?.startsWith("session:") ? sessionId : undefined,
    blockId: blockId?.startsWith("block:") ? blockId : undefined,
  };
}

/** True when the process runs inside a Rex terminal. */
export function isRex(env: NodeJS.ProcessEnv): boolean {
  return readRexEnv(env).sessionId !== undefined || env.TERM_PROGRAM === "rex";
}

/** Default unix socket path for the Rex server, per platform. */
export function defaultSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.REX_SOCKET) return env.REX_SOCKET;
  if (process.platform === "darwin") {
    const home = env.HOME;
    return home
      ? `${home}/Library/Application Support/rex/server.sock`
      : undefined;
  }
  if (env.XDG_RUNTIME_DIR) return `${env.XDG_RUNTIME_DIR}/rex/server.sock`;
  const home = env.HOME;
  return home ? `${home}/.local/state/rex/server.sock` : undefined;
}
