import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { installLogger, takeEvents } from "./events";
import { find } from "./find";
import { frameBox, hitFrame, listFrames } from "./frames";
import { inspect, setColor } from "./inspect";
import { locate } from "./locate";
import { syntheticClick } from "./mouse";
import { pageText } from "./pageText";
import { scroll, scrollIntoView } from "./scroll";
import { snapshot } from "./snapshot";
import { readPage } from "./tree";

installLogger();

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    if (request.op === "ping")
      return { ok: true, url: location.href, title: document.title };
    if (request.op === "snapshot") return snapshot();
    if (request.op === "locate")
      return await locate(request.ref, request.clip, request.scroll);
    if (request.op === "events")
      return takeEvents(request.clear, request.arm, request.watch);
    if (request.op === "inspect") return inspect(request.ref);
    if (request.op === "setColor") return setColor(request.ref, request.value);
    if (request.op === "syntheticClick")
      return syntheticClick(request.ref, request.action, request.modifiers);
    if (request.op === "readPage")
      return readPage(
        request.filter,
        request.maxChars,
        request.ref,
        request.depth,
        request.prefix,
      );
    if (request.op === "find") return find(request.name, request.role);
    if (request.op === "pageText") return pageText(request.maxChars);
    if (request.op === "scroll")
      return scroll(request.ref, request.left, request.top);
    if (request.op === "scrollIntoView") return scrollIntoView(request.ref);
    if (request.op === "frames") return listFrames();
    if (request.op === "frameBox") return frameBox(request.ref, request.reveal);
    if (request.op === "hitFrame") return hitFrame(request.ref, request.points);
    return {
      ok: false,
      error: `unknown op ${JSON.stringify((request as { op: unknown }).op)}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `${request.op} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Safari's browser.runtime.onMessage delivers the resolved promise as the response.
browser.runtime.onMessage.addListener((request: ContentRequest) =>
  handle(request),
);
