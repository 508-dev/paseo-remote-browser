import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const TUNNEL_WINDOW = 256 * 1024;
export const TUNNEL_CHUNK = 64 * 1024;
export const tunnelOpen = defineSubscription({
  name: "tunnel.open",
  input: z.object({ workspaceId: z.string(), port: z.number().int().min(1).max(65535) }),
  event: z.union([
    z.instanceof(Uint8Array),
    z.object({ type: z.literal("ready"), token: z.string().uuid() }),
    z.object({ type: z.literal("end") }),
  ]),
});
export const tunnelWrite = defineRpc({
  name: "tunnel.write",
  input: z.instanceof(Uint8Array),
  output: z.null(),
});

/** UUID capability (36 ASCII bytes), opcode (data=0, credit=1, half-close=2), payload. */
export function tunnelPacket(
  token: string,
  opcode: number,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error("Invalid tunnel token");
  const bytes = new Uint8Array(37 + payload.length);
  for (let i = 0; i < 36; i++) bytes[i] = token.charCodeAt(i);
  bytes[36] = opcode;
  bytes.set(payload, 37);
  return bytes;
}

export function parseTunnelPacket(bytes: Uint8Array) {
  if (bytes.length < 37 || bytes.length > 37 + TUNNEL_CHUNK)
    throw new Error("Invalid tunnel packet length");
  const token = String.fromCharCode(...bytes.subarray(0, 36));
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error("Invalid tunnel token");
  const opcode = bytes[36]!;
  const payload = bytes.subarray(37);
  if (
    opcode > 2 ||
    (opcode === 1 && payload.length !== 4) ||
    (opcode === 2 && payload.length !== 0)
  )
    throw new Error("Invalid tunnel operation");
  return { token, opcode, payload };
}
