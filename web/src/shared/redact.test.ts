import { expect, test } from "vitest";
import { isSecretParameter, redactUrl, wordsOf } from "./redact";
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
