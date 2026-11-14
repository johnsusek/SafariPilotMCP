import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { thrown } from "./frames";
import {
  accessDeadlineMs,
  accessFailure,
  accessFrom,
  probeAccess,
  refused,
  siteOf,
  withinAccess,
} from "./access";

// WebKit's own wording for a call on a site the extension has no access to.
let executeRefusal = new Error(
  "Invalid call to scripting.executeScript(). this extension does not have access to this tab.",
);
let captureRefusal = new Error(
  "Invalid call to tabs.captureVisibleTab(). either the 'activeTab' permission or granted host permissions for the current website are required.",
);

let executeScript: ReturnType<typeof vi.fn>;

beforeEach(() => {
  executeScript = vi.fn();
  vi.stubGlobal("browser", { scripting: { executeScript } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeAccess", () => {
  test("a script that runs means the site is granted", async () => {
    executeScript.mockResolvedValue([{ frameId: 0, result: true }]);
    expect(await probeAccess(5)).toBe("granted");
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 5, frameIds: [0] },
      func: expect.any(Function),
    });
  });

  test("Safari's refusal means denied", async () => {
    executeScript.mockRejectedValue(executeRefusal);
    expect(await probeAccess(5)).toBe("denied");
  });

  test("a script still held at the deadline means the prompt is open", async () => {
    vi.useFakeTimers();
    executeScript.mockReturnValue(new Promise(() => {}));
    let probe = probeAccess(5);
    await vi.advanceTimersByTimeAsync(accessDeadlineMs);
    expect(await probe).toBe("prompt");
  });

  test("any other failure says nothing about access", async () => {
    executeScript.mockRejectedValue(
      new Error("could not execute script on this tab"),
    );
    expect(await probeAccess(5)).toBe("unknown");
  });
});

describe("withinAccess", () => {
  test("a lookup that answers in time passes through", async () => {
    expect(await withinAccess(Promise.resolve({ id: 5 }), 5)).toEqual({
      id: 5,
    });
    expect(await withinAccess(Promise.resolve(null), 5)).toBeNull();
  });

  test("a lookup held past the deadline throws the prompt failure", async () => {
    vi.useFakeTimers();
    let held = withinAccess(new Promise(() => {}), 5).catch(accessFrom);
    await vi.advanceTimersByTimeAsync(accessDeadlineMs);
    expect(await held).toMatchObject({ ok: false, code: "site_access_prompt" });
  });
});

describe("failures", () => {
  test("refusals are told from other errors", () => {
    expect(refused(executeRefusal)).toBe(true);
    expect(refused(captureRefusal)).toBe(true);
    expect(refused(new Error("tab not found"))).toBe(false);
  });

  test("only http and https pages have a site to grant", () => {
    expect(siteOf("https://a.test/path?q=1")).toBe("https://a.test");
    expect(siteOf("http://127.0.0.1:8765/x")).toBe("http://127.0.0.1:8765");
    expect(siteOf("about:blank")).toBeNull();
    expect(siteOf("")).toBeNull();
    expect(siteOf(undefined)).toBeNull();
  });

  test("the prompt and the refusal name the site and what the user does", () => {
    let prompt = accessFailure("prompt", 5, "https://a.test/page");
    expect(prompt).toMatchObject({ ok: false, code: "site_access_prompt" });
    expect(prompt.error).toMatch(
      /^Safari is asking the user whether SafariPilot may use https:\/\/a\.test and holds every call for tab 5 /,
    );
    expect(prompt.error).toMatch(
      /Ask your user to find Safari's permission prompt \(it may be behind other windows/,
    );
    expect(prompt.error).toContain(
      'Safari Settings > Extensions > SafariPilot, where "Always Allow on Every Website" grants every site at once',
    );
    let denied = accessFailure("denied", 5, "https://a.test/page");
    expect(denied.error).toMatch(
      /^Safari has not granted SafariPilot access to https:\/\/a\.test \(refused, or never allowed\)\. Ask your user/,
    );
    expect(accessFailure("prompt", null).error).toContain(
      "may use the site in the active tab and holds every call for the active tab",
    );
  });

  test("a thrown access failure comes back intact; other errors do not", () => {
    let failure = accessFailure("denied", 5, "https://a.test/");
    expect(failure.code).toBe("site_access_denied");
    expect(accessFrom(thrown(failure))).toBe(failure);
    expect(
      accessFrom(thrown({ ok: false, error: "x", code: "timed_out" })),
    ).toBeNull();
    expect(accessFrom(new Error("other"))).toBeNull();
    expect(accessFrom(null)).toBeNull();
  });
});
