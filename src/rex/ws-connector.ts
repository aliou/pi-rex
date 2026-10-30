import net from "node:net";
import { WebSocket } from "ws";
import type { ControlConnection, ControlConnector } from "./control";

/**
 * Real transport for the control protocol: a WebSocket over the Rex server's
 * unix socket. `ws` is used because it accepts a custom socket factory;
 * Node's built-in WebSocket cannot dial a unix path.
 */
export function createSocketConnector(socketPath: string): ControlConnector {
  return () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://rex/api/control", ["rex.control.v1"], {
        createConnection: () => net.connect(socketPath),
      });
      const connection: ControlConnection = {
        send: (text) => ws.send(text),
        close: () => ws.close(),
        onMessage: (handler) =>
          ws.on("message", (data) => handler(String(data))),
        onClose: (handler) => ws.on("close", () => handler()),
      };
      ws.once("open", () => resolve(connection));
      ws.once("error", (err) => reject(err));
    });
}
