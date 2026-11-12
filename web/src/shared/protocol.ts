// Background sends a ContentRequest with browser.tabs.sendMessage; the content script answers with a ContentResponse.
// All coordinates are CSS px relative to the top-level layout viewport.

export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type Point = { left: number; top: number };

export type Viewport = {
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  visualScale: number;
  visualOffsetLeft: number;
  visualOffsetTop: number;
  // Size of the visible region (visualViewport.width/height), CSS px, scrollbars excluded.
  visualWidth?: number;
  visualHeight?: number;
  // Layout viewport without scrollbars (documentElement.clientWidth/clientHeight), CSS px.
  clientWidth?: number;
  clientHeight?: number;
};

export type ElementInfo = {
  ref: number;
  tag: string;
  role: string;
  name: string;
  rect: Rect;
  inViewport: boolean;
  disabled?: boolean;
};

export type LoggedEvent = {
  type: string;
  isTrusted: boolean;
  ref: number | null;
  target: string;
  time: number;
  detail: string;
};

export type ContentRequest =
  | { op: "ping" }
  | { op: "snapshot" }
  | { op: "locate"; ref: number }
  | { op: "events"; clear: boolean };

export type Failure = { ok: false; error: string };
export type PingResult = { ok: true; url: string; title: string };
export type SnapshotResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  elements: ElementInfo[];
};
export type LocateResult = {
  ok: true;
  ref: number;
  rect: Rect;
  point: Point;
  hitsTarget: boolean;
  hitDescription: string;
  viewport: Viewport;
};
export type EventsResult = { ok: true; events: LoggedEvent[] };
export type ContentResponse =
  | Failure
  | PingResult
  | SnapshotResult
  | LocateResult
  | EventsResult;
