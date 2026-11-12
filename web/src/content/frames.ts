import type { FramesResult } from "../shared/protocol";
import { flatElements } from "./flat";
import { refFor } from "./refs";

export function listFrames(): FramesResult {
  let frames = [...flatElements(document)]
    .filter((element) => element instanceof HTMLIFrameElement)
    .map((iframe) => {
      let box = iframe.getBoundingClientRect();
      let frameId = -1;

      try {
        frameId = browser.runtime.getFrameId(iframe);
      } catch {}

      return {
        ref: refFor(iframe),
        frameId,
        src: iframe.hasAttribute("srcdoc")
          ? "srcdoc"
          : iframe.src || "about:blank",
        sandbox: iframe.getAttribute("sandbox"),
        rect: {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        },
      };
    });
  return { ok: true, url: location.href, title: document.title, frames };
}
