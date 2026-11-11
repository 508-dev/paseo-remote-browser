import type { PluginServerContext } from "@getpaseo/plugin/server";
import { RemoteBrowser } from "./server/browser";
import { browserRpc } from "./shared/browser";

export default function contribute(server: PluginServerContext) {
  const browser = new RemoteBrowser();
  server.handle(browserRpc, async (input, { paseo }) => {
    // A client cannot open a browser session for a workspace it cannot see.
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace) throw new Error("Workspace unavailable");
    return browser.control(input);
  });
  server.addHook("workspace.archive.after", async ({ workspace }) => {
    await browser.closeWorkspace(workspace.id);
  });
  return () => browser.close();
}
