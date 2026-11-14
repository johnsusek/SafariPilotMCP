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
