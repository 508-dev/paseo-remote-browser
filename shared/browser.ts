import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const VIEWPORT = { width: 1024, height: 768 } as const;

export const browserRpc = defineRpc({
  name: "browser.control",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("snapshot"), workspaceId: z.string() }),
    z.object({ action: z.literal("navigate"), workspaceId: z.string(), url: z.string() }),
    z.object({
      action: z.literal("click"),
      workspaceId: z.string(),
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    z.object({ action: z.literal("type"), workspaceId: z.string(), text: z.string().max(65536) }),
    z.object({
      action: z.literal("key"),
      workspaceId: z.string(),
      key: z.string().min(1).max(40),
      phase: z.enum(["down", "up", "press"]).default("press"),
    }),
    z.object({
      action: z.literal("scroll"),
      workspaceId: z.string(),
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    z.object({
      action: z.literal("pointer"),
      workspaceId: z.string(),
      phase: z.enum(["move", "down", "up"]),
      x: z.number().finite(),
      y: z.number().finite(),
      button: z.enum(["left", "middle", "right"]).default("left"),
    }),
    z.object({ action: z.literal("back"), workspaceId: z.string() }),
    z.object({ action: z.literal("forward"), workspaceId: z.string() }),
    z.object({ action: z.literal("reload"), workspaceId: z.string() }),
  ]),
  output: z.object({ url: z.string(), title: z.string() }),
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

export const browserStream = defineSubscription({
  name: "browser.stream",
  input: z.object({ workspaceId: z.string() }),
  event: z.union([
    z.instanceof(Uint8Array),
    z.object({ streamId: z.string(), url: z.string(), title: z.string() }),
  ]),
});

export const browserAck = defineRpc({
  name: "browser.ack",
  input: z.object({ streamId: z.string().uuid(), sequence: z.number().int().positive() }),
  output: z.null(),
});

/** A frame starts with a big-endian u32 sequence, followed by a complete JPEG. */
export function decodeFrame(bytes: Uint8Array) {
  if (bytes.byteLength < 5) throw new Error("Truncated browser frame");
  return {
    sequence: new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0),
    jpeg: bytes.subarray(4),
  };
}

export type BrowserInput = {
  [Action in BrowserAction["action"]]: Omit<
    Extract<BrowserAction, { action: Action }>,
    "workspaceId"
  >;
}[BrowserAction["action"]];

/** Native Image needs a URI; only the render boundary encodes bytes, never the transport. */
export function jpegUri(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    parts.push(
      alphabet[a >> 2]! +
        alphabet[((a & 3) << 4) | (b >> 4)]! +
        (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=") +
        (i + 2 < bytes.length ? alphabet[c & 63] : "="),
    );
  }
  return `data:image/jpeg;base64,${parts.join("")}`;
}
