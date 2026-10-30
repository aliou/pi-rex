/**
 * Rex server control protocol (`rex.control.v1`).
 *
 * The server speaks JSON over a WebSocket: hello/welcome handshake, then
 * request/response calls, then server-pushed events once a session is
 * attached. The connection itself is injected, so callers choose the
 * transport (a unix-socket WebSocket in the extension, a fake in tests).
 *
 * Protocol observed with the logging proxy in ~/tmp/2026-10-30-rex/probe/.
 */

export interface ControlConnection {
  send(text: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

/** Opens a connection. Resolves when the transport is up, before the handshake. */
export type ControlConnector = () => Promise<ControlConnection>;

export type ControlPayload = Record<string, unknown>;

interface ServerFrame {
  type: "welcome" | "response" | "event";
  id?: string;
  /** Event frames carry a monotonic seq beside the payload. */
  seq?: number;
  payload?: ControlPayload;
}

export interface RexServerEvent {
  seq: number;
  payload: ControlPayload;
}

export class ControlClientError extends Error {}

export class RexControlClient {
  private connection: ControlConnection | undefined;
  private welcome:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (payload: ControlPayload) => void; reject: (err: Error) => void }
  >();
  private nextRequestId = 0;
  private eventHandler: ((event: RexServerEvent) => void) | undefined;

  constructor(
    private readonly connector: ControlConnector,
    private readonly options: {
      clientName: string;
      /** The server answers hello with its `api_revision`; mismatch closes. */
      apiRevision?: number;
      onEvent?: (event: RexServerEvent) => void;
    },
  ) {
    this.eventHandler = options.onEvent;
  }

  get connected(): boolean {
    return this.connection !== undefined;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    const connection = await this.connector();
    connection.onMessage((text) => this.handleFrame(text));
    connection.onClose(() => this.handleClose());
    this.connection = connection;
    const welcomed = new Promise<void>((resolve, reject) => {
      this.welcome = { resolve, reject };
      // The server answers the handshake with an unsolicited `welcome` frame;
      // every other reply carries the request id. Time out so a silent server
      // does not hang session start.
      const timeout = setTimeout(
        () => reject(new ControlClientError("handshake timed out")),
        5000,
      );
      timeout.unref?.();
    });
    connection.send(
      JSON.stringify({
        type: "hello",
        api_revision: this.options.apiRevision,
        client: {
          kind: "other",
          name: this.options.clientName,
          version: "0.1.0",
        },
      }),
    );
    await welcomed;
  }

  /** Call a server API method, e.g. `session.attach`. */
  async call(
    method: string,
    payload?: ControlPayload,
  ): Promise<ControlPayload> {
    const id = `rexpi-${this.nextRequestId++}`;
    this.sendOrThrow(JSON.stringify({ type: "request", id, method, payload }));
    return this.waitForResponse(id);
  }

  /** Start receiving events for a session; they arrive through onEvent. */
  async attach(sessionId: string): Promise<void> {
    await this.call("session.attach", { session_id: sessionId });
  }

  close(): void {
    this.connection?.close();
    this.handleClose();
  }

  private sendOrThrow(text: string): void {
    if (!this.connection) {
      throw new ControlClientError("not connected");
    }
    this.connection.send(text);
  }

  private waitForResponse(id: string): Promise<ControlPayload> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private handleFrame(text: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "welcome") {
      this.welcome?.resolve();
      this.welcome = undefined;
      return;
    }
    if (frame.type === "event") {
      if (typeof frame.seq === "number" && frame.payload) {
        this.eventHandler?.({ seq: frame.seq, payload: frame.payload });
      }
      return;
    }
    const id = frame.id;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(frame.payload ?? {});
  }

  private handleClose(): void {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    this.welcome?.reject(new ControlClientError("connection closed"));
    this.welcome = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new ControlClientError("connection closed"));
    }
    this.pending.clear();
  }
}
