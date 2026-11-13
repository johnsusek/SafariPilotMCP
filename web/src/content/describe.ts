import { flatChildren, flatParent, isInvisible, isPruned } from "./flat";

let inputRoles: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  color: "button",
  file: "button",
};

let tagRoles: Record<string, string> = {
  button: "button",
  summary: "button",
  textarea: "textbox",
  option: "option",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
  img: "img",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  article: "article",
  form: "form",
  dialog: "dialog",
  ul: "list",
  ol: "list",
  menu: "list",
  li: "listitem",
  dl: "list",
  dt: "term",
  dd: "definition",
  table: "table",
  tr: "row",
  td: "cell",
  th: "columnheader",
  fieldset: "group",
  details: "group",
  hr: "separator",
  progress: "progressbar",
  meter: "meter",
  iframe: "iframe",
  blockquote: "blockquote",
  pre: "code",
  code: "code",
  svg: "img",
};

// Roles whose accessible name comes from their text content.
export let contentRoles = new Set([
  "button",
  "link",
  "heading",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "checkbox",
  "radio",
  "switch",
  "tooltip",
  "term",
]);

// Container roles that ARIA names only from the author, never from their content, even when focusable.
export let authorRoles = new Set([
  "alertdialog",
  "dialog",
  "form",
  "grid",
  "listbox",
  "menu",
  "menubar",
  "radiogroup",
  "region",
  "tabpanel",
  "table",
  "tablist",
  "toolbar",
  "tree",
  "treegrid",
]);

let nameMax = 80;

let svgTitle = (element: Element) =>
  element.localName === "svg"
    ? element.querySelector(":scope > title")?.textContent?.trim()
    : "";

let formTags = new Set(["input", "select", "textarea"]);

// Text an element shows, as accessible name from content: shadow trees and slots included, hidden subtrees skipped, and a descendant's aria-label or an image's alt standing in for its content.
function contentText(node: Node, parts: string[], budget: { left: number }) {
  let hidden: boolean | undefined;

  for (let child of flatChildren(node)) {
    if (budget.left <= 0) return;

    if (child.nodeType === Node.TEXT_NODE) {
      hidden ??= node instanceof Element && isInvisible(node);

      if (hidden) continue;

      let text = child.textContent ?? "";
      parts.push(text);
      budget.left -= text.length;
      continue;
    }

    if (!(child instanceof Element)) continue;

    // A br has no box, so it would be pruned before it could separate words.
    if (child.localName === "br") {
      parts.push(" ");
      continue;
    }

    if (isPruned(child) || formTags.has(child.localName)) continue;

    if (isInvisible(child)) {
      contentText(child, parts, budget);
      continue;
    }

    let label =
      child.getAttribute("aria-label")?.trim() ||
      (child.localName === "img" ? child.getAttribute("alt")?.trim() : "") ||
      svgTitle(child);

    if (label) {
      parts.push(` ${label} `);
      budget.left -= label.length;
      continue;
    }

    // Block boxes and line breaks separate words, as browsers do when they name from content.
    let display = getComputedStyle(child).display;
    let gap = /^(inline|contents|$)/.test(display) ? "" : " ";
    let start = parts.length;
    parts.push(gap);
    contentText(child, parts, budget);
    let title = child.getAttribute("title")?.trim();

    if (title && !parts.slice(start).join("").trim()) parts.push(` ${title} `);

    parts.push(gap);
  }
}

let shownText = (element: Element) => {
  let parts: string[] = [];
  contentText(element, parts, { left: nameMax * 8 });
  return collapse(parts.join(""));
};

export function collapse(text: string | null | undefined, max = nameMax) {
  let clean = (text ?? "")
    .slice(0, max * 8)
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

// Inside an editor every descendant is contenteditable, but only the outermost is the text field.
export let isEditableRoot = (element: Element) =>
  (element as HTMLElement).isContentEditable &&
  !(flatParent(element) as HTMLElement | null)?.isContentEditable;

export function roleOf(element: Element) {
  let explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  let tag = element.localName;
  if (tag === "a" || tag === "area")
    return element.hasAttribute("href") ? "link" : "generic";
  if (tag === "input")
    return inputRoles[(element as HTMLInputElement).type] ?? "textbox";
  if (tag === "select")
    return (element as HTMLSelectElement).multiple ||
      (element as HTMLSelectElement).size > 1
      ? "listbox"
      : "combobox";
  if (tagRoles[tag]) return tagRoles[tag];
  if (isEditableRoot(element)) return "textbox";
  return "generic";
}

// Each referenced element counts by its own aria-label, else its rendered text; a hidden one (a common label source) by its raw text.
function labelledByText(element: Element) {
  let ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  let root = element.getRootNode() as Document | ShadowRoot;
  return ids
    .map((id) => root.getElementById(id))
    .filter((target) => target !== null)
    .map(
      (target) =>
        target.getAttribute("aria-label")?.trim() ||
        shownText(target) ||
        collapse(target.textContent),
    )
    .join(" ");
}

// fromContent false skips text content, for containers whose text is rendered as their children.
export function nameOf(element: Element, fromContent = true) {
  let input = element as HTMLInputElement;
  let isTextField =
    element.localName === "textarea" ||
    isEditableRoot(element) ||
    (element.localName === "input" && !inputRoles[input.type]);
  let candidates = [
    () => labelledByText(element),
    () => element.getAttribute("aria-label"),
    () =>
      "labels" in input && input.labels
        ? [...new Set(Array.from(input.labels, shownText))].join(" ")
        : "",
    () =>
      element.localName === "input" &&
      inputRoles[input.type] === "button" &&
      input.type !== "file"
        ? input.value || input.alt
        : "",
    () => (element.localName === "img" ? element.getAttribute("alt") : ""),
    () => svgTitle(element),
    () =>
      element.localName === "fieldset"
        ? element.querySelector(":scope > legend")?.textContent
        : "",
    () =>
      element.localName === "table"
        ? element.querySelector(":scope > caption")?.textContent
        : "",
    () => {
      if (!fromContent || isTextField || element.localName === "select")
        return "";

      return shownText(element);
    },
    () => element.getAttribute("title"),
    () => element.getAttribute("placeholder"),
  ];

  for (let candidate of candidates) {
    let name = collapse(candidate());
    if (name) return name;
  }

  return "";
}

export function describe(target: EventTarget | null) {
  if (!target) return "null";
  if (target === window) return "window";
  if (target === document) return "document";
  if (!(target instanceof Element)) return target.constructor.name;
  let id = target.id ? `#${target.id}` : "";
  let className =
    typeof target.className === "string"
      ? target.className.trim().split(/\s+/)[0]
      : "";
  let isPageRoot =
    target === document.body || target === document.documentElement;
  let text = isPageRoot ? "" : collapse(target.textContent, 24);
  return `${target.localName}${id}${className ? `.${className}` : ""}${text ? ` "${text}"` : ""}`;
}
