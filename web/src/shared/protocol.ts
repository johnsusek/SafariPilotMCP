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
  // Focuses ref, or its nearest ancestor that takes focus, with element.focus().
  | { op: "focus"; ref: number }
  // Dispatches untrusted pointer and mouse events at the element's center and focuses as a press would, with no other default actions.
  | {
      op: "syntheticClick";
      ref: number;
      action: ClickAction;
      modifiers: Modifier[];
    }
  // Presses ref and drags to the center of to, both in this frame, as untrusted events: an HTML5 drag from a draggable element, else pointer and mouse moves.
  | { op: "drag"; ref: number; to: number }
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
  // The first shown element holding text (case and whitespace ignored) or matching selector; exactly one of them is set.
  | { op: "waitFor"; text: string | null; selector: string | null }
  | { op: "pageText"; maxChars: number }
  | { op: "scroll"; ref: number | null; left: number; top: number }
  | { op: "scrollIntoView"; ref: number }
  | { op: "frames" }
  // reveal scrolls the iframe into view when part of it is outside the viewport.
  | { op: "frameBox"; ref: number; reveal: boolean }
  // Whether each point lands on the iframe itself, in this frame's coordinates.
  | { op: "hitFrame"; ref: number; points: Point[] }
  // This frame's newest limit console messages matching onlyErrors and pattern (a case-insensitive regular expression); clear empties its buffer after reading.
  | {
      op: "console";
      onlyErrors: boolean;
      pattern: string | null;
      limit: number;
      clear: boolean;
    }
  // The body record of this frame's fetch or XMLHttpRequest call with url and method that started closest to time (epoch ms).
  | { op: "networkBody"; url: string; method: string; time: number };

// What a caller does about a failure; errorCodes.json gives each code its retry flag and next step, which the MCP server adds to the reply.
export type ErrorCode = keyof (typeof import("./errorCodes.json"))["codes"];

export type Failure = {
  ok: false;
  error: string;
  code: ErrorCode;
};

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
// drag: source is what the drag started from (the draggable element around the press for an HTML5 drag, else the pressed element), target where it ended;
// html5 says dragstart ran and was not canceled, dropped that a dragover was canceled so drop fired; dispatched merges runs of one event type, canceled when any was.
export type DragResult = {
  ok: true;
  ref: number;
  to: number;
  source: string;
  target: string;
  html5: boolean;
  dropped: boolean;
  dispatched: { type: string; canceled: boolean; count: number }[];
};
// focus: focused is the active element; taken says ref or an ancestor below body took focus, which Safari refuses in a cross-origin frame that has had no real click.
export type FocusResult = {
  ok: true;
  ref: number;
  focused: string;
  taken: boolean;
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
  | "slider"
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
  min: number | null;
  max: number | null;
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

// waitFor: the matched element with the text it shows, collapsed to 80 characters, or null when nothing matches yet.
export type WaitMatch = ElementInfo & { text: string };
export type WaitForResult = {
  ok: true;
  url: string;
  title: string;
  match: WaitMatch | null;
};

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

// exception is an uncaught error or an unhandled promise rejection.
export type ConsoleLevel =
  "log" | "info" | "warn" | "error" | "debug" | "exception";
// time is epoch ms, url the frame's document URL when logged, source the caller's url:line:column when known.
export type ConsoleEntry = {
  level: ConsoleLevel;
  text: string;
  time: number;
  url: string;
  source: string | null;
};
// capturing is false when the frame has no main-world capture (it loaded before the extension); matched counts matches before limit,
// dropped the oldest entries a full buffer let go since the last clear.
export type ConsoleResult = {
  ok: true;
  capturing: boolean;
  entries: ConsoleEntry[];
  matched: number;
  dropped: number;
};

// A fetch or XMLHttpRequest call the main-world capture recorded: url is absolute, time epoch ms when the page made the call, bodies text cut at the capture's
// maxBody (truncated says the response was), and note why responseBody is null (still loading, not text, failed) or null once it is read.
export type BodyRecord = {
  method: string;
  url: string;
  time: number;
  requestBody: string | null;
  status: number | null;
  contentType: string;
  responseBody: string | null;
  truncated: boolean;
  note: string | null;
};
// capturing is false when the frame has no main-world capture (it loaded before the extension); record is null when no call matched.
export type NetworkBodyResult = {
  ok: true;
  capturing: boolean;
  record: BodyRecord | null;
};

export type ContentResponse =
  | Failure
  | PingResult
  | SnapshotResult
  | LocateResult
  | EventsResult
  | InspectResult
  | ClickResult
  | DragResult
  | FocusResult
  | UploadResult
  | ReadPageResult
  | FindResult
  | WaitForResult
  | PageTextResult
  | ScrollResult
  | FramesResult
  | FrameBoxResult
  | HitFrameResult
  | ConsoleResult
  | NetworkBodyResult;
