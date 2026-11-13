import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import { parseTunnelPacket, TUNNEL_CHUNK, TUNNEL_WINDOW } from "../shared/tunnel";

type Event = Uint8Array | { type: "ready"; token: string } | { type: "end" };
interface Tunnel {
  socket: Socket;
  workspaceId: string;
  outstanding: number;
  input: Promise<unknown>;
  queued: number;
}

/** The subscribed viewer alone receives the write capability; release destroys its TCP socket. */
export class PortTunnels {
  private readonly sockets = new Map<string, Tunnel>();

  async open(
    workspaceId: string,
    port: number,
    { push, signal }: Pick<PluginSubscriptionContext<Event>, "push" | "signal">,
  ) {
    if (signal.aborted) return;
    if (this.sockets.size >= 64) throw new Error("Too many open tunnel connections");
    // Deliberately loopback-only: this prototype is for host-local dev servers, not arbitrary routing.
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.pause();
    const token = randomUUID();
    const tunnel: Tunnel = {
      socket,
      workspaceId,
      outstanding: 0,
      input: Promise.resolve(),
      queued: 0,
    };
    this.sockets.set(token, tunnel);
    let pending: Buffer = Buffer.alloc(0);
    let sending = false;
    let ready = false;
    let ended = false;
    let endSent = false;
    const pump = async () => {
      if (sending || !ready || signal.aborted || socket.destroyed) return;
      sending = true;
      try {
        while (pending.length && tunnel.outstanding < TUNNEL_WINDOW) {
          const length = Math.min(pending.length, TUNNEL_CHUNK, TUNNEL_WINDOW - tunnel.outstanding);
          const chunk = pending.subarray(0, length);
          pending = pending.subarray(length);
          tunnel.outstanding += length;
          await push(chunk);
        }
        if (!pending.length && ended && !endSent) {
          endSent = true;
          await push({ type: "end" });
        }
        if (!pending.length && !ended && tunnel.outstanding < TUNNEL_WINDOW) socket.resume();
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error("Tunnel delivery failed"));
      } finally {
        sending = false;
      }
    };
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      pending = chunk;
      void pump();
    });
    socket.on("end", () => {
      ended = true;
      void pump();
    });
    // Finite idle lifetime also bounds a viewer that stops acknowledging without disconnecting.
    socket.setTimeout(60_000, () => socket.destroy(new Error("Tunnel idle timeout")));
    const credit = () => {
      void pump();
    };
    socket.on("tunnel-credit", credit);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", () => resolve());
        socket.once("connect", () => {
          void push({ type: "ready", token })
            .then(() => {
              ready = true;
              return pump();
            })
            .catch(reject);
        });
        if (signal.aborted) socket.destroy();
      });
    } finally {
      signal.removeEventListener("abort", abort);
      this.sockets.delete(token);
      socket.destroy();
    }
  }

  async write(bytes: Uint8Array): Promise<null> {
    const { token, opcode, payload } = parseTunnelPacket(bytes);
    const tunnel = this.sockets.get(token);
    if (!tunnel || tunnel.socket.destroyed) throw new Error("Tunnel closed");
    if (opcode === 1) {
      const credit = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
      if (!credit || credit > tunnel.outstanding) throw new Error("Invalid tunnel credit");
      tunnel.outstanding -= credit;
      tunnel.socket.emit("tunnel-credit");
      return null;
    }
    if (tunnel.queued + payload.length > TUNNEL_WINDOW)
      throw new Error("Tunnel input window exceeded");
    tunnel.queued += payload.length;
    const operation = tunnel.input.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (opcode === 2) {
            tunnel.socket.end(resolve);
            return;
          }
          tunnel.socket.write(payload, (error) => (error ? reject(error) : resolve()));
        }),
    );
    tunnel.input = operation.catch(() => {});
    try {
      await operation;
      return null;
    } finally {
      tunnel.queued -= payload.length;
    }
  }

  closeWorkspace(workspaceId: string) {
    for (const tunnel of this.sockets.values())
      if (tunnel.workspaceId === workspaceId) tunnel.socket.destroy();
  }
  close() {
    for (const tunnel of this.sockets.values()) tunnel.socket.destroy();
  }
}
