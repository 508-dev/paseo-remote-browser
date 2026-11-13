import { createServer as httpServer, request } from "node:http";
import { createServer, createConnection, type Server } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { PortTunnels } from "./tunnel";
import { tunnelPacket, TUNNEL_WINDOW } from "../shared/tunnel";
import { createTunnelListener } from "../companion/forward.mjs";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  return address.port;
}

/** Exercise the actual companion and actual TCP sockets, adapting just the Paseo message boundary. */
function adapter(tunnels: PortTunnels): Pick<DaemonClient, "observePluginRpc" | "invokePluginRpc"> {
  return {
    invokePluginRpc: async (_plugin, _method, input) => tunnels.write(input as Uint8Array),
    observePluginRpc: (_plugin, _method, input, options) => {
      const { workspaceId, port } = input as { workspaceId: string; port: number };
      const controller = new AbortController();
      options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      let done = Promise.resolve();
      return {
        subscriptionId: "test",
        ready: Promise.resolve({ subscriptionId: "test", requestId: "test" }),
        subscribe(observer) {
          observer.snapshot({ subscriptionId: "test", requestId: "test" });
          done = tunnels
            .open(workspaceId, port, {
              signal: controller.signal,
              push: async (event) => {
                if (event instanceof Uint8Array) observer.binary?.(event);
                else
                  observer.update({
                    type: "plugin.rpc.event",
                    payload: { subscriptionId: "test", event },
                  });
              },
            })
            .then(
              () =>
                observer.update({ type: "plugin.rpc.closed", payload: { subscriptionId: "test" } }),
              (error: unknown) => observer.error?.(error),
            );
          return () => {};
        },
        async release() {
          controller.abort();
          await done;
        },
      };
    },
  };
}

async function forwarded(remotePort: number) {
  const tunnels = new PortTunnels();
  const companion = createTunnelListener(adapter(tunnels), { workspaceId: "preview", remotePort });
  const port = await listen(companion.listener);
  cleanup.push(async () => {
    await companion.close();
    tunnels.close();
  });
  return port;
}

describe("local browser port forwarding", () => {
  it("preserves streamed HTTP responses, cookies, redirects and binary uploads", async () => {
    const upstream = httpServer(async (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/result", "Set-Cookie": "preview=yes; Path=/" });
        res.end();
        return;
      }
      if (req.url === "/upload") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.end(Buffer.concat(chunks));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 30);
    });
    const port = await forwarded(await listen(upstream));
    const redirect = await fetch(`http://127.0.0.1:${port}/redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/result");
    expect(redirect.headers.get("set-cookie")).toBe("preview=yes; Path=/");
    await redirect.arrayBuffer();
    const response = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe("data: first\n\n");
    const second = await reader.read();
    expect(Buffer.from(second.value!).toString()).toBe("data: second\n\n");
    expect((await reader.read()).done).toBe(true);
    const body = Buffer.alloc(TUNNEL_WINDOW * 3, 0xa5);
    const uploaded = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body });
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(body);
  }, 15_000);

  it("keeps WebSocket upgrades and full duplex traffic intact", async () => {
    const upstream = httpServer();
    upstream.on("upgrade", (_req, socket, head) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      if (head.length) socket.write(head);
      socket.on("data", (bytes) => socket.write(bytes));
      socket.on("end", () => socket.destroy());
    });
    const port = await forwarded(await listen(upstream));
    const result = await new Promise<Buffer>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      req.on("error", reject);
      req.on("upgrade", (res, socket) => {
        expect(res.statusCode).toBe(101);
        const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
        socket.once("data", (bytes) => {
          resolve(bytes);
          socket.destroy();
        });
        socket.write(frame);
      });
      req.end();
    });
    expect(result).toEqual(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]));
  }, 10_000);

  it("stops at its read window and releases upstream connections when the viewer leaves", async () => {
    let peer: import("node:net").Socket | undefined;
    const upstream = createServer((socket) => {
      peer = socket;
      socket.write(Buffer.alloc(TUNNEL_WINDOW * 2));
    });
    const port = await listen(upstream);
    const tunnels = new PortTunnels();
    cleanup.push(() => tunnels.close());
    const controller = new AbortController();
    let token = "";
    let bytes = 0;
    const done = tunnels.open("window", port, {
      signal: controller.signal,
      push: async (event) => {
        if (event instanceof Uint8Array) bytes += event.byteLength;
        else if (event.type === "ready") token = event.token;
      },
    });
    await expect.poll(() => bytes).toBe(TUNNEL_WINDOW);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bytes).toBe(TUNNEL_WINDOW);
    const credit = Buffer.alloc(4);
    credit.writeUInt32BE(TUNNEL_WINDOW);
    await tunnels.write(tunnelPacket(token, 1, credit));
    await expect.poll(() => bytes).toBe(TUNNEL_WINDOW * 2);
    controller.abort();
    await done;
    peer?.resume();
    await expect.poll(() => peer?.destroyed).toBe(true);
    await expect(tunnels.write(tunnelPacket(token, 0, Buffer.from("late")))).rejects.toThrow(
      "Tunnel closed",
    );
  });

  it("preserves TCP half-close while a response exceeds the read window", async () => {
    const response = Buffer.alloc(TUNNEL_WINDOW * 3, 0xb7);
    const upstream = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on("end", () => socket.end(response));
    });
    const port = await forwarded(await listen(upstream));
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.end("request");
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(response);
  }, 10_000);

  it("drains queued response bytes when normal closure races an in-flight credit", async () => {
    const expected = Buffer.concat([Buffer.alloc(64 * 1024, 0x31), Buffer.alloc(64 * 1024, 0x32)]);
    let closeRemote: () => void = () => {};
    const client: Pick<DaemonClient, "observePluginRpc" | "invokePluginRpc"> = {
      invokePluginRpc: async (_plugin, _method, input) => {
        if ((input as Uint8Array)[36] === 1) {
          // The host closes and removes its token before this credit RPC returns.
          closeRemote();
          throw new Error("Tunnel closed");
        }
        return null;
      },
      observePluginRpc: () => ({
        subscriptionId: "closing",
        ready: Promise.resolve({ subscriptionId: "closing", requestId: "closing" }),
        subscribe(observer) {
          observer.snapshot({ subscriptionId: "closing", requestId: "closing" });
          closeRemote = () =>
            observer.update({ type: "plugin.rpc.closed", payload: { subscriptionId: "closing" } });
          observer.update({
            type: "plugin.rpc.event",
            payload: {
              subscriptionId: "closing",
              event: { type: "ready", token: "00000000-0000-4000-8000-000000000001" },
            },
          });
          observer.binary?.(expected.subarray(0, 64 * 1024));
          observer.binary?.(expected.subarray(64 * 1024));
          return () => {};
        },
        async release() {},
      }),
    };
    const companion = createTunnelListener(client, { workspaceId: "closing", remotePort: 3000 });
    const port = await listen(companion.listener);
    cleanup.push(() => companion.close());
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.end("request");
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk);
    const received = Buffer.concat(chunks);
    expect(received.byteLength).toBe(expected.byteLength);
    expect(received.equals(expected)).toBe(true);
  });

  it("reports refused upstream ports instead of leaving a live subscription", async () => {
    const upstream = createServer();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const tunnels = new PortTunnels();
    await expect(
      tunnels.open("refused", port, { signal: new AbortController().signal, push: async () => {} }),
    ).rejects.toThrow(/ECONNREFUSED/);
    tunnels.close();
  });
});
