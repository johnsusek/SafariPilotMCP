// Messages between the background and the native app (relayed by the appex over loopback TCP).
import type { ContentRequest, ContentResponse } from "../shared/protocol";

export type Instance = { id: string; startedAt: number };

export type NativeCommand =
  | { id: string; type: "content"; request: ContentRequest }
  | { id: string; type: "tabs" }
  | { id: string; type: "navigate"; url: string }
  | { id: string; type: "screenshot" };

export type TabInfo = {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
};

export type CommandResponse =
  | ContentResponse
  | { ok: true; tabs: TabInfo[] }
  | { ok: true; tabId: number; url: string }
  | { ok: true; dataUrl: string };

export type PollResult = { id: string; response: CommandResponse };

export type ToNative =
  | { kind: "poll"; instance: Instance; result?: PollResult }
  | { kind: "lifecycle"; instance: Instance; event: string; at: number };

export type PollReply = { command?: NativeCommand | null; error?: string };
