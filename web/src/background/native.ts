// Messages between the background and the native app (relayed by the appex over loopback TCP).
import type { Command, CommandResponse } from "../shared/commands";

export type Instance = { id: string; startedAt: number };

export type NativeCommand = Command & { id: string };

export type PollResult = { id: string; response: CommandResponse };

export type ToNative =
  | { kind: "poll"; instance: Instance; result?: PollResult }
  | { kind: "lifecycle"; instance: Instance; event: string; at: number }
  | { kind: "keepalive"; instance: Instance };

export type PollReply = { command?: NativeCommand | null; error?: string };
