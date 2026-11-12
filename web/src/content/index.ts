import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { installLogger, takeEvents } from "./events";
import { locate } from "./locate";
import { snapshot } from "./snapshot";

installLogger();

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    if (request.op === "ping")
      return { ok: true, url: location.href, title: document.title };
    if (request.op === "snapshot") return snapshot();
    if (request.op === "locate") return await locate(request.ref);
    if (request.op === "events")
      return { ok: true, events: takeEvents(request.clear) };
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
