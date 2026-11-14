// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { isSensitive } from "./sensitive";

let field = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector("[data-field]")!;
};

test.each([
  '<input data-field type="password">',
  '<input data-field type="PASSWORD">',
  '<input data-field autocomplete="one-time-code">',
  '<input data-field autocomplete="section-pay cc-csc">',
  '<input data-field autocomplete="cc-number">',
  '<input data-field type="tel" autocomplete="new-password">',
  '<input data-field type="email" autocomplete="current-password">',
  '<input data-field name="user_password">',
  '<input data-field name="newpassword">',
  '<input data-field id="cardNumber">',
  '<input data-field name="cc-num">',
  '<input data-field name="cvv">',
  '<input data-field type="number" name="pin">',
  '<input data-field aria-label="Security code">',
  '<input data-field placeholder="Verification code">',
  '<input data-field aria-label="SSN">',
  '<input data-field name="iban">',
  '<input data-field name="2fa">',
  '<input data-field name="client_secret">',
  '<input data-field name="accessToken">',
  '<input data-field name="x-api-key">',
  "<label>Credit card <input data-field></label>",
  '<label for="f">Passphrase</label><input data-field id="f">',
  '<textarea data-field aria-label="Private key"></textarea>',
  '<div data-field contenteditable="true" aria-label="Password"></div>',
])("secret: %s", (html) => {
  expect(isSensitive(field(html))).toBe(true);
});

test.each([
  '<input data-field name="email">',
  '<input data-field name="shipping">',
  '<input data-field name="passenger">',
  '<input data-field aria-label="Card name">',
  '<input data-field name="scorecard_title">',
  '<input data-field aria-label="Promo code">',
  '<input data-field aria-label="PIN code">',
  '<input data-field name="pincode">',
  '<input data-field aria-label="Secretary">',
  '<input data-field aria-label="Discount">',
  '<input data-field type="email" name="password_reset_email">',
  '<input data-field type="search" placeholder="Search tokens">',
  '<input data-field type="checkbox" name="remember_password">',
  '<input data-field type="hidden" name="csrf_token">',
  '<input data-field type="date" name="card_expiry">',
  '<input data-field autocomplete="cc-exp">',
  '<select data-field name="password"><option>a</option></select>',
  '<button data-field name="token">Go</button>',
  '<div data-field aria-label="Password">not editable</div>',
])("not secret: %s", (html) => {
  expect(isSensitive(field(html))).toBe(false);
});

test("a password a show-password toggle turned into text stays secret", () => {
  let input = field('<input data-field type="password" name="field-7">');
  expect(isSensitive(input)).toBe(true);
  input.setAttribute("type", "text");
  expect(isSensitive(input)).toBe(true);
});
