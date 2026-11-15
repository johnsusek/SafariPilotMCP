// Messages between the background and the native app (relayed by the appex over loopback TCP).
import type { Command, CommandResponse } from "../shared/commands";

// build is the identity web/build.mjs stamped into this bundle; the app refuses polls from a build other than its own.
export type Instance = { id: string; startedAt: number; build: string };

export type NativeCommand = Command & { id: string };

// ms is how long the command ran here, so the app can tell it from the native messaging around it.
export type PollResult = { id: string; response: CommandResponse; ms: number };

export type ToNative =
  | { kind: "poll"; instance: Instance; result?: PollResult }
  | { kind: "lifecycle"; instance: Instance; event: string; at: number }
  | { kind: "keepalive"; instance: Instance };

export type PollReply = { command?: NativeCommand | null; error?: string };
