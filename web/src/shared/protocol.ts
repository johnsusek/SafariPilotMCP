// Background sends a ContentRequest to one frame with browser.tabs.sendMessage; that frame's content script answers with a ContentResponse.
// Refs here are that frame's own numbers, and coordinates are CSS px relative to that frame's layout viewport; the background composes them into top-frame ones.

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
  // With an events watch: whether the target is the watched element, inside it, one of its labels, or an ancestor of it.
  onTarget?: boolean;
};

// Click kinds named like Claude in Chrome's computer actions, and the keys held during a click.
export type ClickAction =
  "left_click" | "double_click" | "triple_click" | "right_click";
export type Modifier = "cmd" | "shift" | "alt" | "ctrl";
// A local file handed to the page: data is its bytes in base64, lastModified epoch ms, mimeType "" when unknown (as browsers report it).
export type UploadFile = {
  name: string;
  mimeType: string;
  lastModified: number;
  data: string;
};

export type ContentRequest =
  | { op: "ping" }
  | { op: "snapshot" }
  // clip limits the points tried to that part of this frame (what its ancestors leave visible); scroll false skips centering the element.
  | { op: "locate"; ref: number; clip: Rect | null; scroll: boolean }
  // arm turns on move and drag-over logging until the next events request; watch is a ref whose element sets each event's onTarget.
  | { op: "events"; clear: boolean; arm: boolean; watch: number | null }
  | { op: "inspect"; ref: number }
  // Sets a color input's value and fires bubbling input and change events, which are untrusted; answers with inspect's read-back.
  | { op: "setColor"; ref: number; value: string }
  // Dispatches untrusted pointer and mouse events at the element's center and focuses as a press would, with no other default actions.
  | {
      op: "syntheticClick";
      ref: number;
      action: ClickAction;
      modifiers: Modifier[];
    }
  // Gives a file input (ref, the label of one, or the only one inside ref) the files through a DataTransfer and fires untrusted input and change;
  // on any other element dispatches untrusted dragenter, dragover and drop carrying them.
  | { op: "upload"; ref: number; files: UploadFile[] }
  // prefix goes in front of every ref in the text, such as "5:" inside the frame of iframe 5.
  | {
      op: "readPage";
      filter: "interactive" | "all";
      maxChars: number;
      ref: number | null;
      depth: number | null;
      prefix: string;
    }
  | { op: "find"; name: string; role: string }
  | { op: "pageText"; maxChars: number }
  | { op: "scroll"; ref: number | null; left: number; top: number }
  | { op: "scrollIntoView"; ref: number }
  | { op: "frames" }
  // reveal scrolls the iframe into view when part of it is outside the viewport.
  | { op: "frameBox"; ref: number; reveal: boolean }
  // Whether each point lands on the iframe itself, in this frame's coordinates.
  | { op: "hitFrame"; ref: number; points: Point[] };

// timeout marks a frame that did not answer in time, as opposed to one that is gone.
export type Failure = { ok: false; error: string; timeout?: true };

// An iframe in this document: frameId is the id Safari gives its frame (-1 when it has none yet), box its content box,
// clip the part of box this document shows (null when none), and transformed whether a CSS transform or zoom moves it,
// which Accessibility ignores. sandbox is the attribute's value, null when absent.
export type FrameEntry = {
  ref: number;
  frameId: number;
  src: string;
  sandbox: string | null;
  box: Rect;
  clip: Rect | null;
  transformed: boolean;
};
export type FramesResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  frames: FrameEntry[];
};
// origin is this frame's performance.timeOrigin; moved is whether reveal scrolled.
export type FrameBoxResult = {
  ok: true;
  frame: FrameEntry;
  moved: boolean;
  viewport: Viewport;
  origin: number;
};
// hitDescription describes what the first point lands on.
export type HitFrameResult = {
  ok: true;
  hits: boolean[];
  hitDescription: string;
};
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
  // In view but under another element; focus-based actions still work then.
  covered: boolean;
  hitDescription: string;
  viewport: Viewport;
  // With a clip: up to 8 points on the element, best first, for the background to test against the ancestor frames.
  candidates: Point[];
};
// syntheticClick: target is what the events went to (the deepest element at the point when inside ref, else ref), dispatched the
// event types in order, canceled when a listener called preventDefault, and focused the active element afterwards.
export type ClickResult = {
  ok: true;
  ref: number;
  target: string;
  dispatched: { type: string; canceled: boolean }[];
  focused: string;
};
// upload: target is the file input that took the files, or what the drop events went to; via says which; files are read back from
// the input or the DataTransfer; dispatched lists the events in order, canceled when a listener called preventDefault.
export type UploadResult = {
  ok: true;
  ref: number;
  target: string;
  via: "input" | "drop";
  files: { name: string; size: number; type: string }[];
  dispatched: { type: string; canceled: boolean }[];
};
// origin is performance.timeOrigin, which changes when the page navigates or reloads.
export type EventsResult = { ok: true; events: LoggedEvent[]; origin: number };

// inspect: whether ref matches :hover, its form value (textContent for contenteditable, null when it has none),
// and what kind of control it is. listbox is a select shown as a list (multiple or size over 1).
// checked is set for checkbox and radio (native or ARIA); selectedIndex and options for both select kinds.
// date, time and datetime-local are the inputs WebKit draws as separate typed fields; color is an input type=color.
export type ControlKind =
  | "text"
  | "checkbox"
  | "radio"
  | "select"
  | "listbox"
  | "date"
  | "time"
  | "datetime-local"
  | "color"
  | "other";
export type SelectOption = { value: string; label: string; disabled: boolean };
export type InspectResult = {
  ok: true;
  ref: number;
  hover: boolean;
  value: string | null;
  secure: boolean;
  kind: ControlKind;
  checked: boolean | null;
  selectedIndex: number | null;
  options: SelectOption[] | null;
};

// readPage: an indented element tree as text, one node per line, with refs from the same
// ref space as snapshot and locate. filter "interactive" keeps only actionable elements;
// ref limits it to that element's subtree and depth to that many levels.
// frames are the iframe lines whose frame has a content script to read: line is the index into the text's lines, depth that line's indent level, width and height the iframe's client size.
export type FramePlaceholder = {
  ref: number;
  frameId: number;
  line: number;
  depth: number;
  width: number;
  height: number;
};
export type ReadPageResult = {
  ok: true;
  url: string;
  title: string;
  viewport: Viewport;
  text: string;
  truncated: boolean;
  frames: FramePlaceholder[];
};

// find: up to 20 visible elements whose name contains name and whose role equals role, case-insensitively; an empty field matches all.
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
// when ref is null. moved is false when nothing could scroll. scrollIntoView answers the same way.
export type ScrollResult = { ok: true; moved: boolean; viewport: Viewport };

export type ContentResponse =
  | Failure
  | PingResult
  | SnapshotResult
  | LocateResult
  | EventsResult
  | InspectResult
  | ClickResult
  | UploadResult
  | ReadPageResult
  | FindResult
  | PageTextResult
  | ScrollResult
  | FramesResult
  | FrameBoxResult
  | HitFrameResult;
