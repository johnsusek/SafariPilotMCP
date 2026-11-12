// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { inspect } from "./inspect";
import { refFor } from "./refs";

test("a password reads back as bullets and is marked secure", () => {
  document.body.innerHTML = '<input type="password" value="hunter2">';
  let result = inspect(refFor(document.querySelector("input")!));
  expect(result).toMatchObject({
    kind: "text",
    secure: true,
    value: "•••••••",
  });
});
