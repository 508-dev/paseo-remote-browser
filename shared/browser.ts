import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const VIEWPORT = { width: 1024, height: 768 } as const;

export const browserRpc = defineRpc({
  name: "browser.control",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("snapshot"), workspaceId: z.string() }),
    z.object({ action: z.literal("navigate"), workspaceId: z.string(), url: z.string() }),
    z.object({ action: z.literal("click"), workspaceId: z.string(), x: z.number(), y: z.number() }),
    z.object({ action: z.literal("type"), workspaceId: z.string(), text: z.string() }),
    z.object({
      action: z.literal("key"),
      workspaceId: z.string(),
      key: z.enum(["Enter", "Tab", "Escape", "Backspace"]),
    }),
    z.object({
      action: z.literal("scroll"),
      workspaceId: z.string(),
      x: z.number(),
      y: z.number(),
    }),
    z.object({ action: z.literal("back"), workspaceId: z.string() }),
    z.object({ action: z.literal("forward"), workspaceId: z.string() }),
    z.object({ action: z.literal("reload"), workspaceId: z.string() }),
  ]),
  output: z.object({ url: z.string(), title: z.string(), image: z.string() }),
});

export type BrowserAction = z.output<typeof browserRpc.input>;

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL");
  const hostWithPort = /^(?:[^:/\s]+|\[[0-9a-f:]+\]):\d+(?:[/?#]|$)/i.test(trimmed);
  const candidate =
    !hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS pages are supported");
  return url.href;
}
