// page_fetch's pick: a JSON path of dot keys (data.items), indexes ([0]) and [] to map the rest of the path over an array (items[].id).
import { thrown } from "./frames";

export type Step = { key: string } | { index: number } | { each: true };

let refuse = (error: string): never => {
  throw thrown({ ok: false, error, code: "invalid_argument" });
};

let key = /^[^.[\]]+/;

export function parsePick(path: string): Step[] {
  let steps: Step[] = [];
  let at = 0;
  let wrong = (why: string) =>
    refuse(
      `pick ${JSON.stringify(path)} ${why}; write dot keys, [n] and [], such as data.items[].id`,
    );

  while (at < path.length) {
    if (path[at] === "[") {
      let close = path.indexOf("]", at);
      let inside = close < 0 ? "" : path.slice(at + 1, close);

      if (close < 0) wrong(`has an unclosed [ at ${at + 1}`);
      if (inside !== "" && !/^\d+$/.test(inside))
        wrong(`has [${inside}], which is neither [n] nor []`);

      steps.push(inside === "" ? { each: true } : { index: Number(inside) });
      at = close + 1;
      continue;
    }

    if (steps.length > 0) {
      if (path[at] !== ".") wrong(`needs a dot before the key at ${at + 1}`);

      at++;
    }

    let name = key.exec(path.slice(at))?.[0];

    if (!name) wrong(`has an empty key at ${at + 1}`);

    steps.push({ key: name! });
    at += name!.length;
  }

  if (steps.length === 0) wrong("is empty");

  return steps;
}

let kind = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;

// What the path finds in value. Outside a [] map a missing key or index fails naming what is there; inside one it gives null, since mapped items differ.
export function pickValue(value: unknown, steps: Step[]) {
  let walk = (
    current: unknown,
    index: number,
    where: string,
    mapped: boolean,
  ): unknown => {
    if (index === steps.length) return current;

    let step = steps[index];
    let at = where || "the body";
    let missing = (why: string) =>
      mapped ? null : refuse(`pick: ${at} ${why}`);

    if ("each" in step) {
      if (!Array.isArray(current))
        return missing(`is ${kind(current)}, not an array`);

      return current.map((item, position) =>
        walk(item, index + 1, `${where}[${position}]`, true),
      );
    }

    if ("index" in step) {
      if (!Array.isArray(current))
        return missing(`is ${kind(current)}, not an array`);
      if (step.index >= current.length)
        return missing(`has ${current.length} items, so no [${step.index}]`);

      return walk(
        current[step.index],
        index + 1,
        `${where}[${step.index}]`,
        mapped,
      );
    }

    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      return missing(`is ${kind(current)}, so it has no key ${step.key}`);

    if (!Object.hasOwn(current, step.key)) {
      let keys = Object.keys(current);
      let listed =
        keys.slice(0, 20).join(", ") + (keys.length > 20 ? ", ..." : "");
      return missing(`has no key ${step.key} (keys: ${listed || "none"})`);
    }

    let next = (current as Record<string, unknown>)[step.key];
    return walk(
      next,
      index + 1,
      where ? `${where}.${step.key}` : step.key,
      mapped,
    );
  };

  return walk(value, 0, "", false);
}
