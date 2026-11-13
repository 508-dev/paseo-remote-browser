import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createHostClient } from "@getpaseo/client/node";
import { tunnelPacket, TUNNEL_CHUNK } from "../shared/tunnel.ts";

/** A real local origin: HTTP, WebSocket upgrades, SSE and uploads share opaque TCP forwarding. */
export function createTunnelListener(
  client,
  { workspaceId, remotePort, pluginId = "remote-browser" },
) {
  const sockets = new Set();
  const listener = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.pause();
    socket.setTimeout(60_000, () => socket.destroy(new Error("Local tunnel idle timeout")));
    const controller = new AbortController();
    const subscription = client.observePluginRpc(
      pluginId,
      "tunnel.open",
      { workspaceId, port: remotePort },
      { signal: controller.signal },
    );
    let token;
    let initialized = false;
    let receive = Promise.resolve();
    let remoteClosed = false;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A failure may precede the async iterator below reaching its first await.
    void ready.catch(() => {});
    const fail = () => socket.destroy(new Error("Remote tunnel closed"));
    const send = (opcode, data) =>
      client.invokePluginRpc(pluginId, "tunnel.write", tunnelPacket(token, opcode, data));
    const unsubscribe = subscription.subscribe({
      snapshot: () => {
        if (initialized) fail();
        initialized = true;
      },
      update: (message) => {
        if (message.type === "plugin.rpc.closed") {
          if (message.payload.error) fail();
          else {
            remoteClosed = true;
            // Closure is ordered after events on the wire, but their local writes may still be queued.
            receive = receive
              .then(() => {
                socket.end();
              })
              .catch(fail);
          }
          return;
        }
        if (message.type !== "plugin.rpc.event") return;
        const event = message.payload.event;
        if (event.type === "ready") {
          token = event.token;
          readyResolve();
        }
        if (event.type === "end")
          receive = receive.then(() => {
            socket.end();
          });
      },
      binary: (bytes) => {
        receive = receive
          .then(async () => {
            await new Promise((resolve, reject) =>
              socket.write(bytes, (error) => (error ? reject(error) : resolve())),
            );
            const credit = Buffer.alloc(4);
            credit.writeUInt32BE(bytes.byteLength);
            if (!remoteClosed) {
              try {
                await send(1, credit);
              } catch (error) {
                // A normally closed subscription has already retired its write capability.
                if (!remoteClosed) throw error;
              }
            }
          })
          .catch(fail);
      },
      error: fail,
    });
    void subscription.ready.catch(fail);
    const timeout = setTimeout(fail, 15_000);
    socket.on("error", () => {
      /* Never log upstream URLs, capabilities or page data. */
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
      readyReject(new Error("Local tunnel closed"));
      controller.abort();
      unsubscribe();
      void subscription.release().catch(() => {});
    });
    void (async () => {
      await ready;
      clearTimeout(timeout);
      // Async iteration paces uploads by RPC completion and bounds local buffering.
      for await (const bytes of socket.iterator({ destroyOnReturn: false })) {
        for (let offset = 0; offset < bytes.length; offset += TUNNEL_CHUNK)
          await send(0, bytes.subarray(offset, offset + TUNNEL_CHUNK));
      }
      if (!socket.destroyed && !remoteClosed) await send(2);
    })().catch(() => {
      if (!remoteClosed) fail();
    });
  });
  listener.on("close", () => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    listener,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    },
  };
}

async function main() {
  const { PASEO_BROWSER_HOST: host, PASEO_BROWSER_WORKSPACE: workspaceId } = process.env;
  const remotePort = Number(process.env.PASEO_BROWSER_REMOTE_PORT || 3000);
  const localPort = Number(process.env.PASEO_BROWSER_LOCAL_PORT || 0);
  if (
    !host ||
    !workspaceId ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535 ||
    !Number.isInteger(localPort) ||
    localPort < 0 ||
    localPort > 65535
  )
    throw new Error(
      "Set PASEO_BROWSER_HOST and PASEO_BROWSER_WORKSPACE; ports must be valid TCP ports",
    );
  const client = createHostClient(host, {
    clientId: `browser-tunnel-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.16.0-beta.1",
    reconnect: { enabled: false },
  });
  let tunnel;
  try {
    await client.connect();
    tunnel = createTunnelListener(client, { workspaceId, remotePort });
    await new Promise((resolve, reject) => {
      tunnel.listener.once("error", reject);
      tunnel.listener.listen(localPort, "127.0.0.1", resolve);
    });
    console.log(`Open http://127.0.0.1:${tunnel.listener.address().port} in your local browser`);
    const shutdown = async () => {
      await tunnel.close();
      await client.close();
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
  } catch (error) {
    await tunnel?.close();
    await client.close();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Tunnel startup failed; check the host connection, workspace and plugin installation",
    );
    process.exitCode = 1;
  });
