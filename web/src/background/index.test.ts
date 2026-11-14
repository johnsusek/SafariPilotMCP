import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("every message to the app names the build of this bundle", async () => {
  // The first poll never answers, so the loop sends one poll and waits.
  let sendNativeMessage = vi.fn(() => new Promise(() => {}));
  let listener = { addListener: vi.fn() };
  vi.stubGlobal("SAFARIPILOT_BUILD", "20261113T120000-abc123");
  vi.stubGlobal("browser", {
    runtime: {
      sendNativeMessage,
      connectNative: () => ({
        onMessage: listener,
        onDisconnect: listener,
        postMessage: vi.fn(),
      }),
      onStartup: listener,
      onInstalled: listener,
    },
    alarms: { onAlarm: listener, create: vi.fn() },
    tabs: { onActivated: listener, onUpdated: listener },
  });

  await import("./index");

  let kinds = sendNativeMessage.mock.calls.map(
    ([, message]: any[]) => message.kind,
  );
  expect(kinds).toEqual(["lifecycle", "poll"]);

  for (let [, message] of sendNativeMessage.mock.calls as any[]) {
    expect(message.instance.build).toBe("20261113T120000-abc123");
  }
});
