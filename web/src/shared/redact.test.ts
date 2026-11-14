import { expect, test } from "vitest";
import {
  isSecretHeader,
  isSecretParameter,
  redactBody,
  redactUrl,
  wordsOf,
} from "./redact";
import cases from "./redactUrl.cases.json" with { type: "json" };

// Tests/RedactionTests.swift runs the same cases against the app's copy of the rule.
test.each(cases)("$url", ({ url, shown }) => {
  expect(redactUrl(url)).toBe(shown);
});

test("names split into words on camelCase, capital runs and separators", () => {
  expect(wordsOf("X-Amz-Signature")).toEqual(["x", "amz", "signature"]);
  expect(wordsOf("SAMLResponse")).toEqual(["saml", "response"]);
  expect(wordsOf("accessToken")).toEqual(["access", "token"]);
  expect(wordsOf("oauth_verifier")).toEqual(["oauth", "verifier"]);
});

test("secret parameter names", () => {
  for (let name of ["token", "auth", "jwt", "otp", "ticket", "sid", "code"])
    expect(isSecretParameter(name), name).toBe(true);

  for (let name of ["q", "state", "zip_code", "keywords", "codec", "passage"])
    expect(isSecretParameter(name), name).toBe(false);
});

test("secret headers", () => {
  for (let name of [
    "Authorization",
    "Cookie",
    "set-cookie",
    "X-Api-Key",
    "X-CSRF-Token",
    "Proxy-Authorization",
  ])
    expect(isSecretHeader(name), name).toBe(true);

  for (let name of ["Accept", "Content-Type", "User-Agent", "Cache-Control"])
    expect(isSecretHeader(name), name).toBe(false);
});

test("bodies hide secret form parameters and JSON values", () => {
  expect(redactBody("user=a&password=b")).toBe("user=a&password=[hidden]");
  expect(
    redactBody(
      '{"token": "abc", "n": {"session_id": 12, "name": "x"}, "list": ["a", "b"]}',
    ),
  ).toBe(
    '{"token": "[hidden]", "n": {"session_id": "[hidden]", "name": "x"}, "list": ["a", "b"]}',
  );
  expect(redactBody('{"password":"a\\"b","x":1')).toBe(
    '{"password":"[hidden]","x":1',
  );
  expect(redactBody("plain text")).toBe("plain text");
  expect(
    redactBody(
      '{"data": "{\\"token\\":\\"abc\\",\\"n\\":1}", "url": "https://a.test/x?api_key=k&q=1"}',
    ),
  ).toBe(
    '{"data": "{\\"token\\":\\"[hidden]\\",\\"n\\":1}", "url": "https://a.test/x?api_key=[hidden]&q=1"}',
  );
});
