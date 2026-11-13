import { PortTunnels } from "./server/tunnel";
import { tunnelOpen, tunnelWrite } from "./shared/tunnel";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BrowserStreams } from "./server/stream";
import { RemoteBrowser } from "./server/browser";
import { browserRpc, browserAck, browserStream } from "./shared/browser";

export default function contribute(server: PluginServerContext) {
  const tunnels = new PortTunnels();
  server.handle(tunnelOpen, async ({ workspaceId, port }, context) => {
    if (!(await context.paseo.workspaces.ref(workspaceId).refresh()))
      throw new Error("Workspace unavailable");
    await tunnels.open(workspaceId, port, context);
  });
  server.handle(tunnelWrite, (input) => tunnels.write(input));
  const browser = new RemoteBrowser();
  const streams = new BrowserStreams();
  server.handle(browserAck, ({ streamId, sequence }) => streams.ack(streamId, sequence));
  server.handle(browserStream, async ({ workspaceId }, context) => {
    if (!(await context.paseo.workspaces.ref(workspaceId).refresh()))
      throw new Error("Workspace unavailable");
    await streams.watch(browser, workspaceId, context);
  });
  server.handle(browserRpc, async (input, { paseo }) => {
    // A client cannot open a browser session for a workspace it cannot see.
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new Error("Workspace unavailable");
    return browser.control(input, false);
  });
  server.addHook("workspace.archive.after", async ({ workspace }) => {
    streams.closeWorkspace(workspace.id);
    tunnels.closeWorkspace(workspace.id);
    await browser.closeWorkspace(workspace.id);
  });
  return async () => {
    streams.close();
    tunnels.close();
    await browser.close();
  };
}
