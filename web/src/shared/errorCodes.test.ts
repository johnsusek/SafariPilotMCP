import { expect, test } from "vitest";
import table from "./errorCodes.json" with { type: "json" };

// The Failure type takes its codes from this file and Tests/ErrorCodeTests.swift checks the Swift enum against it, so both sides use one table.
test("every code has a retry flag and one of the next steps", () => {
  let codes = Object.entries(table.codes);
  expect(codes.length).toBeGreaterThan(0);

  for (let [code, { retryable, next }] of codes) {
    expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    expect(typeof retryable).toBe("boolean");
    expect(table.next).toContain(next);
  }

  expect(new Set(table.next).size).toBe(table.next.length);
  expect(table.codes.failed).toEqual({
    retryable: false,
    next: "read_message",
  });
});
