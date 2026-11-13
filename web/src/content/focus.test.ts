// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { focusRef } from "./focus";
import { refFor } from "./refs";

beforeEach(() => {
  document.body.innerHTML = '<input id="field"><p id="plain">Plain</p>';
});

let element = (id: string) => document.getElementById(id)!;

describe("focusRef", () => {
  test("focuses a field", () => {
    expect(focusRef(refFor(element("field")))).toMatchObject({ ok: true });
    expect(document.activeElement).toBe(element("field"));
  });

  test("focuses inside an open shadow root", () => {
    let host = element("plain");
    let input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    expect(focusRef(refFor(input))).toMatchObject({ ok: true });
    expect(host.shadowRoot!.activeElement).toBe(input);
  });
});
