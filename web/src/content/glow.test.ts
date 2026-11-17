// @vitest-environment happy-dom
import { beforeEach, expect, test } from "vitest";
import { glow } from "./glow";
import { treeText } from "./tree";

beforeEach(() => {
  document.querySelector("safaripilot-glow")?.remove();
  document.body.innerHTML = "<p>Hello</p>";
});

test("draws one hidden-from-readers host and toggles it", () => {
  glow(true);
  glow(true);
  let hosts = document.querySelectorAll("safaripilot-glow");
  expect(hosts).toHaveLength(1);
  let host = hosts[0] as HTMLElement;
  expect(host.getAttribute("aria-hidden")).toBe("true");
  expect(host.shadowRoot).toBeNull();
  expect(host.style.getPropertyValue("display")).toBe("block");
  glow(false);
  expect(host.style.getPropertyValue("display")).toBe("none");
});

test("stays out of read_page", () => {
  glow(true);
  expect(treeText(document.documentElement, "all", 10000).text).not.toMatch(
    /glow/,
  );
});
