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
  // Consecutive identical armed-type entries (same type, target and trust) merged into one; 1 otherwise.
  count: number;
};

export type ContentRequest =
  | { op: "ping" }
  | { op: "snapshot" }
  | { op: "locate"; ref: number }
  // arm turns on move and drag-over logging until the next events request.
  | { op: "events"; clear: boolean; arm: boolean }
  | { op: "inspect"; ref: number }
  | { op: "readPage"; filter: "interactive" | "all"; maxChars: number }
  | { op: "find"; query: string }
  | { op: "pageText"; maxChars: number }
  | { op: "scroll"; ref: number | null; left: number; top: number };

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
// origin is performance.timeOrigin, which changes when the page navigates or reloads.
export type EventsResult = { ok: true; events: LoggedEvent[]; origin: number };

// inspect: whether ref matches :hover and its form value (textContent for contenteditable), null when it has none.
export type InspectResult = {
  ok: true;
  ref: number;
  hover: boolean;
  value: string | null;
};

// readPage: an indented element tree as text, one node per line, with refs from the same
// ref space as snapshot and locate. filter "interactive" keeps only actionable elements.
export type ReadPageResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  text: string;
  truncated: boolean;
};

// find: up to 20 visible elements whose role, name or text contains the query, case-insensitively.
// Matches get refs even when they are not interactive.
export type FindResult = { ok: true; matches: ElementInfo[] };

// pageText: readable text of the page, main or article content first, else the body.
export type PageTextResult = {
  ok: true;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
};

// scroll: scrolls by (left, top) CSS px the nearest scrollable ancestor of ref, or the document
// when ref is null. moved is false when nothing could scroll.
export type ScrollResult = { ok: true; moved: boolean; viewport: Viewport };

export type ContentResponse =
  | Failure
  | PingResult
  | SnapshotResult
  | LocateResult
  | EventsResult
  | InspectResult
  | ReadPageResult
  | FindResult
  | PageTextResult
  | ScrollResult;
