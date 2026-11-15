// Stands in for a secret that never leaves the page or the app: a field's value, a URL's credentials. Shared/Redaction.swift keeps the same rule.
export let hidden = "[hidden]";

// Words of a name: camelCase and runs of capitals are split, then anything that is not a letter or digit separates.
export let wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

let secretWords = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "pass",
  "passcode",
  "key",
  "apikey",
  "sig",
  "signature",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "session",
  "sessionid",
  "sid",
  "jwt",
  "otp",
  "oob",
  "ticket",
  "assertion",
  "bearer",
  "verifier",
  "saml",
  "samlresponse",
]);

// Names run together as one word: accesstoken, PHPSESSID, jsessionid, clientsecret.
let secretEndings = [
  "token",
  "secret",
  "password",
  "signature",
  "apikey",
  "sessid",
  "sessionid",
];

export function isSecretParameter(name: string) {
  let decoded = name;

  try {
    decoded = decodeURIComponent(name);
  } catch {}

  let words = wordsOf(decoded);
  let joined = words.join("");

  if (joined === "code") return true;

  return (
    words.some((word) => secretWords.has(word)) ||
    secretEndings.some((ending) => joined.endsWith(ending))
  );
}

// Userinfo and the values of secret-named query, fragment and ;path parameters become [hidden]; the rest stays as written.
export function redactUrl(url: string) {
  return url
    .replace(
      /^([a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i,
      (_match, scheme: string | undefined) => `${scheme ?? ""}//${hidden}@`,
    )
    .replace(
      /([?&#;])([^=?&#;]*)=([^?&#;]*)/g,
      (match, separator: string, name: string, value: string) =>
        value && isSecretParameter(name)
          ? `${separator}${name}=${hidden}`
          : match,
    );
}

// Headers whose whole value is a secret: cookies by name, and any header named like a secret parameter (Authorization, X-Api-Key, X-CSRF-Token).
let cookieHeaders = new Set(["cookie", "set-cookie", "cookie2", "set-cookie2"]);

export let isSecretHeader = (name: string) =>
  cookieHeaders.has(name.toLowerCase()) || isSecretParameter(name);

export let redactHeaders = (headers: { name: string; value?: string }[]) =>
  headers.map(({ name, value }) => ({
    name,
    value: isSecretHeader(name) ? hidden : (value ?? ""),
  }));

// Names hold no quote or brace, so compact JSON holding a URL with a query (no whitespace, = and & inside) is not taken for a form.
let formBody = /^[^=&\s"{}]+=[^&\s]*(&[^=&\s"{}]+=[^&\s]*)*$/;

// A JSON key and its scalar value, a string or a bare word such as a number, plain or escaped inside a JSON string ({\"token\":\"x\"}).
// Read with patterns rather than JSON.parse, so a body cut short is still redacted.
let jsonField = /("([\w$.-]+)"\s*:\s*)("(?:[^"\\]|\\.)*"|[\w.+-]+)/g;
let escapedField =
  /(\\"([\w$.-]+)\\"\s*:\s*)(\\"(?:[^"\\]|\\(?!")[\s\S])*\\"|[\w.+-]+)/g;
let urlInText = /https?:\/\/[^\s"'<>\\]+/g;

// A form body (a=1&b=2) hides its secret-named parameters; any other text the scalar values of secret-named JSON keys at any depth and the secrets of every URL in it.
export function redactBody(body: string) {
  if (formBody.test(body.trim())) return redactUrl(`?${body.trim()}`).slice(1);

  return body
    .replace(jsonField, (match, head: string, name: string) =>
      isSecretParameter(name) ? `${head}"${hidden}"` : match,
    )
    .replace(escapedField, (match, head: string, name: string) =>
      isSecretParameter(name) ? `${head}\\"${hidden}\\"` : match,
    )
    .replace(urlInText, (url) => redactUrl(url));
}
