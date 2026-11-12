import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { installLogger, takeEvents } from "./events";
import { find } from "./find";
import { listFrames } from "./frames";
import { inspect } from "./inspect";
import { locate } from "./locate";
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
    if (request.op === "locate") return await locate(request.ref);
    if (request.op === "events") return takeEvents(request.clear, request.arm);
    if (request.op === "inspect") return inspect(request.ref);
    if (request.op === "readPage")
      return readPage(
        request.filter,
        request.maxChars,
        request.ref,
        request.depth,
      );
    if (request.op === "find") return find(request.name, request.role);
    if (request.op === "pageText") return pageText(request.maxChars);
    if (request.op === "scroll")
      return scroll(request.ref, request.left, request.top);
    if (request.op === "scrollIntoView") return scrollIntoView(request.ref);
    if (request.op === "frames") return listFrames();
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
