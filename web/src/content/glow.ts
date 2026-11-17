import type { GlowResult, PilotedQuery } from "../shared/protocol";

// An orange edge glow marks a tab SafariPilot drives. It sits in a closed shadow root under an aria-hidden host, so page walks, Accessibility and
// hit tests never see it, and its animation is infinite, which the diff's animation finishing skips.
let host: HTMLElement | null = null;

let style = `
div { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgb(234 88 62 / 0.8), inset 0 0 28px 6px rgb(234 88 62 / 0.45); animation: pulse 2.4s ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: 0.55; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { div { animation: none; } }
`;

function attach() {
  host = document.createElement("safaripilot-glow");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute(
    "style",
    "all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;",
  );
  let root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${style}</style><div></div>`;
  document.documentElement.append(host);
}

export function glow(shown: boolean): GlowResult {
  if (window !== window.top || !document.documentElement) return { ok: true };

  if (!host?.isConnected) attach();

  host!.style.setProperty("display", shown ? "block" : "none", "important");
  // Laid out now, so a capture the background takes next sees the change.
  host!.getBoundingClientRect();
  return { ok: true };
}

// The background answers for pilot tabs only; any failure, such as a background still waking, leaves the page as it was.
export async function askPiloted() {
  if (window !== window.top) return;

  let query: PilotedQuery = { op: "piloted" };
  let piloted = await browser.runtime.sendMessage(query).catch(() => false);

  if (piloted !== true) return;

  if (document.documentElement) {
    glow(true);
    return;
  }

  document.addEventListener("DOMContentLoaded", () => glow(true), {
    once: true,
  });
}
