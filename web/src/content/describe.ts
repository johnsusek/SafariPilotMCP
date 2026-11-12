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
};

let nameMax = 80;

export function collapse(text: string | null | undefined, max = nameMax) {
  let clean = (text ?? "")
    .slice(0, max * 8)
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

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
  if ((element as HTMLElement).isContentEditable) return "textbox";
  return "generic";
}

function labelledByText(element: Element) {
  let ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  let root = element.getRootNode() as Document | ShadowRoot;
  return ids.map((id) => root.getElementById(id)?.textContent ?? "").join(" ");
}

export function nameOf(element: Element) {
  let input = element as HTMLInputElement;
  let isTextField =
    element.localName === "textarea" ||
    (element.localName === "input" && !inputRoles[input.type]);
  let candidates = [
    () => labelledByText(element),
    () => element.getAttribute("aria-label"),
    () =>
      "labels" in input && input.labels
        ? Array.from(input.labels, (label) => label.textContent).join(" ")
        : "",
    () =>
      element.localName === "input" && inputRoles[input.type] === "button"
        ? input.value || input.alt
        : "",
    () => (element.localName === "img" ? element.getAttribute("alt") : ""),
    () =>
      isTextField || element.localName === "select" ? "" : element.textContent,
    () => element.querySelector("img[alt]")?.getAttribute("alt"),
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
