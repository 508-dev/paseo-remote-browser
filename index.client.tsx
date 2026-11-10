import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BrowserPanel } from "./client/browser-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "remote-browser",
    title: "Host browser",
    icon: "Globe",
    context: "workspace",
    Component: BrowserPanel,
  });
  client.addCommandCenterItem({
    id: "open-remote-browser",
    title: "Open host browser",
    icon: "Globe",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("remote-browser");
    },
  });
  return () => {};
}
