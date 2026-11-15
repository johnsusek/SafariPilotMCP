import { describe, expect, test } from "vitest";
import { failureFrom } from "./frames";
import { parsePick, pickValue } from "./pick";

let failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return failureFrom(error);
  }

  throw new Error("did not fail");
};

let pick = (value: unknown, path: string) => pickValue(value, parsePick(path));

describe("parsePick", () => {
  test("reads dot keys, indexes and maps", () => {
    expect(parsePick("data.items[].id")).toEqual([
      { key: "data" },
      { key: "items" },
      { each: true },
      { key: "id" },
    ]);
    expect(parsePick("[0].a-b[12][]")).toEqual([
      { index: 0 },
      { key: "a-b" },
      { index: 12 },
      { each: true },
    ]);
    expect(parsePick("$meta.total count")).toEqual([
      { key: "$meta" },
      { key: "total count" },
    ]);
  });

  test("refuses malformed paths as invalid_argument", () => {
    for (let path of ["", ".a", "a..b", "a[", "a[x]", "a[-1]", "a[0]b", "a."])
      expect(
        failure(() => parsePick(path)),
        path,
      ).toMatchObject({
        code: "invalid_argument",
        error: expect.stringContaining(`pick ${JSON.stringify(path)}`),
      });
  });
});

describe("pickValue", () => {
  let body = {
    data: {
      items: [
        { id: 1, tags: ["a", "b"] },
        { id: 2, tags: [] },
        { name: "no id" },
      ],
      total: 3,
    },
  };

  test("follows keys and indexes", () => {
    expect(pick(body, "data.total")).toBe(3);
    expect(pick(body, "data.items[1]")).toEqual({ id: 2, tags: [] });
    expect(pick(body, "data.items[0].tags[1]")).toBe("b");
    expect(pick([10, 20], "[1]")).toBe(20);
  });

  test("maps over arrays, with null where an item lacks the rest", () => {
    expect(pick(body, "data.items[].id")).toEqual([1, 2, null]);
    expect(pick(body, "data.items[].tags[0]")).toEqual(["a", null, null]);
    expect(pick(body, "data.items[].tags[]")).toEqual([["a", "b"], [], null]);
  });

  test("fails outside a map naming what is there", () => {
    expect(failure(() => pick(body, "data.count"))).toMatchObject({
      code: "invalid_argument",
      error: "pick: data has no key count (keys: items, total)",
    });
    expect(failure(() => pick(body, "data.items[5]"))?.error).toBe(
      "pick: data.items has 3 items, so no [5]",
    );
    expect(failure(() => pick(body, "data.total.x"))?.error).toBe(
      "pick: data.total is number, so it has no key x",
    );
    expect(failure(() => pick(body, "data[]"))?.error).toBe(
      "pick: data is object, not an array",
    );
    expect(failure(() => pick(null, "a"))?.error).toBe(
      "pick: the body is null, so it has no key a",
    );
  });

  test("reads only own keys", () => {
    expect(failure(() => pick({}, "constructor"))?.error).toBe(
      "pick: the body has no key constructor (keys: none)",
    );
  });
});
