import { wordsOf } from "../shared/redact";

let secretAutocomplete = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
]);

// Inputs whose value is chosen rather than typed, or is never a secret.
let exemptTypes = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
  "range",
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

// An email address or a search is never a secret, so only type and autocomplete count for these.
let unhintedTypes = new Set(["email", "search"]);

let secretWords = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "passcode",
  "passphrase",
  "pin",
  "otp",
  "totp",
  "mfa",
  "2fa",
  "cvv",
  "cvv2",
  "cvc",
  "csc",
  "ssn",
  "iban",
  "secret",
  "token",
  "apikey",
]);

// Matched anywhere in a hint's words run together, so newpassword, cardNumber and "Credit card" count.
let secretRuns = [
  "password",
  "passcode",
  "passphrase",
  "apikey",
  "privatekey",
  "accesskey",
  "cardnumber",
  "ccnumber",
  "ccnum",
  "creditcard",
  "securitycode",
  "verificationcode",
  "onetimecode",
  "socialsecurity",
];

let secretEndings = ["secret", "token"];

let hintMax = 256;

// A show-password toggle turns a password into a text field, so one seen as a password stays secret.
let wasPassword = new WeakSet<Element>();

function isSecretHint(hint: string) {
  let words = wordsOf(hint.slice(0, hintMax));
  let joined = words.join("");

  // An Indian postal "PIN code" is an address, not a PIN.
  let pin = words.findIndex((word) => word === "pin");

  if (pin >= 0 && words[pin + 1] === "code") words.splice(pin, 1);

  return (
    words.some((word) => secretWords.has(word)) ||
    secretRuns.some((run) => joined.includes(run)) ||
    secretEndings.some((ending) => joined.endsWith(ending))
  );
}

// Whether a field holds a secret whose value must not leave the page: a password, a one-time code, a card number or CVC, or a field named like one.
export function isSensitive(element: Element) {
  let input = element instanceof HTMLInputElement ? element : null;
  let editable =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable);

  if (!input && !editable) return false;

  let type = input?.type ?? "";

  if (type === "password") wasPassword.add(element);

  if (wasPassword.has(element)) return true;

  if (exemptTypes.has(type)) return false;

  let autocomplete = (element.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);

  if (autocomplete.some((token) => secretAutocomplete.has(token))) return true;

  if (unhintedTypes.has(type)) return false;

  let labels = input?.labels ?? (element as HTMLTextAreaElement).labels ?? [];
  let hints = [
    element.getAttribute("name"),
    element.id,
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    ...Array.from(labels, (label) => label.textContent),
  ];
  return hints.some((hint) => hint && isSecretHint(hint));
}
