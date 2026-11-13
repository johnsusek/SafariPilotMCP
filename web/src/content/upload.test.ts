// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import type { UploadFile } from "../shared/protocol";
import { refFor } from "./refs";
import { upload } from "./upload";

let file = (name: string, text: string, mimeType = "text/plain") => ({
  name,
  mimeType,
  lastModified: 1700000000000,
  data: btoa(text),
});
// happy-dom has no DragEvent; Safari's carries init.dataTransfer as dataTransfer.
(window as unknown as { DragEvent: unknown }).DragEvent = function (
  type: string,
  init: MouseEventInit & { dataTransfer: DataTransfer },
) {
  let event = new MouseEvent(type, init);
  Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
  return event;
};
let seen: Event[] = [];
let record = (event: Event) => seen.push(event);

for (let type of [
  "input",
  "change",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
])
  window.addEventListener(type, record, true);

beforeEach(() => {
  seen = [];
  document.body.innerHTML = `
    <input id="many" type="file" multiple>
    <input id="one" type="file">
    <input id="off" type="file" disabled>
    <label id="label" for="hidden">Upload</label><input id="hidden" type="file" style="display:none">
    <div id="zone">Drop here<input id="inner" type="file" hidden></div>
    <div id="pair"><input type="file"><input type="file"></div>
    <div id="dropzone"><span>Drop files</span></div>
    <div id="plain">Plain</div>`;
});

let element = (id: string) => document.getElementById(id)!;
let send = (id: string, files: UploadFile[]) =>
  upload(refFor(element(id)), files);
let types = () => seen.map((event) => event.type);

describe("upload", () => {
  test("a multiple file input takes every file, then input and change fire", async () => {
    let result = send("many", [
      file("a.txt", "hello"),
      file("b.bin", "\u0001\u0002", ""),
    ]);
    expect(result).toMatchObject({
      ok: true,
      via: "input",
      target: "input#many",
      files: [
        { name: "a.txt", size: 5, type: "text/plain" },
        { name: "b.bin", size: 2, type: "" },
      ],
      dispatched: [
        { type: "input", canceled: false },
        { type: "change", canceled: false },
      ],
    });
    expect(types()).toEqual(["input", "change"]);
    expect(seen.every((event) => event.bubbles)).toBe(true);
    let files = (element("many") as HTMLInputElement).files!;
    expect(await files[0].text()).toBe("hello");
    expect(files[0].lastModified).toBe(1700000000000);
    expect([...new Uint8Array(await files[1].arrayBuffer())]).toEqual([1, 2]);
  });

  test("a single file input refuses several files and keeps its value", () => {
    let result = send("one", [file("a.txt", "a"), file("b.txt", "b")]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/takes one file .* 2 were given/),
    });
    expect((element("one") as HTMLInputElement).files?.length ?? 0).toBe(0);
    expect(seen).toEqual([]);
    expect(send("one", [file("a.txt", "a")])).toMatchObject({
      ok: true,
      target: "input#one",
    });
  });

  test("a disabled input is refused", () => {
    expect(send("off", [file("a.txt", "a")])).toMatchObject({
      ok: false,
      error: "input#off is disabled",
    });
  });

  test("a label or a container hands the files to its one file input", () => {
    expect(send("label", [file("a.txt", "a")])).toMatchObject({
      ok: true,
      via: "input",
      target: "input#hidden",
    });
    expect(send("zone", [file("b.txt", "b")])).toMatchObject({
      ok: true,
      via: "input",
      target: "input#inner",
    });
    expect((element("inner") as HTMLInputElement).files![0].name).toBe("b.txt");
  });

  test("a container with several file inputs names them", () => {
    expect(send("pair", [file("a.txt", "a")])).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /holds 2 file inputs.*\[ref=\d+\] input.*\[ref=\d+\] input/,
      ),
    });
  });

  test("a file input inside a shadow root is found", () => {
    let host = element("plain");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<input id="shadowed" type="file">';
    expect(send("plain", [file("a.txt", "a")])).toMatchObject({
      ok: true,
      target: "input#shadowed",
    });
  });

  test("a drop zone that accepts dragover gets the files in a drop", async () => {
    let dropped: File[] = [];
    let zone = element("dropzone");
    zone.addEventListener("dragover", (event) => event.preventDefault());
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropped = Array.from((event as DragEvent).dataTransfer!.files);
    });
    let result = send("dropzone", [file("photo.png", "png!", "image/png")]);
    expect(result).toMatchObject({
      ok: true,
      via: "drop",
      files: [{ name: "photo.png", size: 4, type: "image/png" }],
      dispatched: [
        { type: "dragenter", canceled: false },
        { type: "dragover", canceled: true },
        { type: "drop", canceled: true },
      ],
    });
    expect(types()).toEqual(["dragenter", "dragover", "drop"]);
    expect(await dropped[0].text()).toBe("png!");
  });

  test("an element that refuses the drag gets dragleave and the frame's file inputs are named", () => {
    let result = send("plain", [file("a.txt", "a")]);
    expect(types()).toEqual(["dragenter", "dragover", "dragleave"]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /did not accept a drop .* nothing was dropped; this frame's file inputs: \[ref=\d+\] input#many/,
      ),
    });
    document.body.innerHTML = '<div id="bare">Bare</div>';
    expect(send("bare", [file("a.txt", "a")])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/this frame has no file input$/),
    });
  });

  test("an iframe ref is refused, pointing inside its frame", () => {
    document.body.innerHTML = '<iframe id="frame"></iframe>';
    expect(send("frame", [file("a.txt", "a")])).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /is an iframe; pass the ref .* inside its frame, such as \d+:12$/,
      ),
    });
    expect(seen).toEqual([]);
  });

  test("an unknown ref fails", () => {
    expect(upload(99999, [file("a.txt", "a")])).toMatchObject({
      ok: false,
      error: "ref 99999 is unknown",
    });
  });
});
