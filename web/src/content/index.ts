import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { startDiff, takeDiff } from "./changes";
import { installReader, takeConsole } from "./console";
import { installLogger, takeEvents } from "./events";
import { drag } from "./drag";
import { find } from "./find";
import { focusRef } from "./focus";
import { frameBox, hitFrame, listFrames } from "./frames";
import { inspect, setColor } from "./inspect";
import { locate } from "./locate";
import { installNetworkReader, takeBody } from "./network";
import { syntheticClick } from "./mouse";
import { installPageFetchReader, pageFetch } from "./pageFetch";
import { pageText } from "./pageText";
import { scroll, scrollIntoView } from "./scroll";
import { snapshot } from "./snapshot";
import { readPage } from "./tree";
import { upload } from "./upload";
import { waitFor } from "./waitFor";

installLogger();
installReader();
installNetworkReader();
installPageFetchReader();

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
    if (request.op === "focus") return focusRef(request.ref);
    if (request.op === "syntheticClick")
      return syntheticClick(request.ref, request.action, request.modifiers);
    if (request.op === "drag") return await drag(request.ref, request.to);
    if (request.op === "upload") return upload(request.ref, request.files);
    if (request.op === "readPage")
      return readPage(
        request.filter,
        request.maxChars,
        request.ref,
        request.depth,
        request.prefix,
      );
    if (request.op === "find") return find(request.name, request.role);
    if (request.op === "waitFor")
      return waitFor(request.text, request.selector);
    if (request.op === "pageText") return pageText(request.maxChars);
    if (request.op === "scroll")
      return scroll(request.ref, request.left, request.top);
    if (request.op === "scrollIntoView") return scrollIntoView(request.ref);
    if (request.op === "frames") return listFrames();
    if (request.op === "frameBox") return frameBox(request.ref, request.reveal);
    if (request.op === "hitFrame") return hitFrame(request.ref, request.points);
    if (request.op === "console")
      return takeConsole(
        request.onlyErrors,
        request.pattern,
        request.limit,
        request.clear,
      );
    if (request.op === "networkBody")
      return takeBody(request.url, request.method, request.time);
    if (request.op === "pageFetch") return await pageFetch(request);
    if (request.op === "diffStart") return startDiff();
    if (request.op === "diff")
      return await takeDiff(request.prefix, request.waitMs, request.maxChars);
    return {
      ok: false,
      error: `unknown op ${JSON.stringify((request as { op: unknown }).op)}`,
      code: "failed",
    };
  } catch (error) {
    return {
      ok: false,
      error: `${request.op} failed: ${error instanceof Error ? error.message : String(error)}`,
      code: "failed",
    };
  }
}

// document.open() makes Safari inject this script again into the same world; with two copies answering, a sync op got refs from one and an async op's failure from the other.
// So only the newest copy answers; Safari's browser.runtime.onMessage delivers the resolved promise as the response.
let shared = globalThis as { safaripilotCopy?: number };
let copy = (shared.safaripilotCopy ?? 0) + 1;
shared.safaripilotCopy = copy;

browser.runtime.onMessage.addListener((request: ContentRequest) =>
  copy === shared.safaripilotCopy ? handle(request) : undefined,
);
