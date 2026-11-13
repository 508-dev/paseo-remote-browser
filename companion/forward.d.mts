import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Server } from "node:net";
export function createTunnelListener(
  client: Pick<DaemonClient, "observePluginRpc" | "invokePluginRpc">,
  input: { workspaceId: string; remotePort: number; pluginId?: string },
): { listener: Server; close(): Promise<void> };
