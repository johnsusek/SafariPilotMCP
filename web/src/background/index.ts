// Push transport: a held-open sendNativeMessage long-poll. The app answers a poll when it has a
// command (or after ~20s with null), so the background always has one poll in flight.
// Wake paths (alarms, tab events, connectNative pushes) restart the loop if Safari unloaded us.
import { runCommand } from "./commands";
import type { Instance, PollReply, PollResult, ToNative } from "./native";
import { forget, pilotOpened, restorePilotTabs } from "./network";

let appId = "net.johnsolo.SafariPilot";
let instance: Instance = {
  id: crypto.randomUUID(),
  startedAt: Date.now(),
  build: SAFARIPILOT_BUILD,
};
let polling = false;

let send = async (message: ToNative) =>
  await browser.runtime.sendNativeMessage(appId, message);

let lifecycle = (event: string) => {
  send({ kind: "lifecycle", instance, event, at: Date.now() }).catch(() => {});
};

let pollLoop = async () => {
  if (polling) return;

  polling = true;

  // A command's result rides on the next poll, so only one native request is ever in flight;
  // this stays correct even if Safari serializes sendNativeMessage calls.
  let result: PollResult | undefined;

  try {
    while (true) {
      let reply = (await send({ kind: "poll", instance, result })) as PollReply;
      result = undefined;

      // The appex replies { error } when the app is unreachable, and the app when this is not its build; stop until the next wake instead of spinning.
      if (reply?.error) throw new Error(reply.error);

      let command = reply?.command;

      if (!command) continue;

      let started = performance.now();
      let response = await runCommand(command);
      result = { id: command.id, response, ms: performance.now() - started };
    }
  } catch (error) {
    lifecycle(`poll failed: ${error}`);
  } finally {
    polling = false;
  }
};

let wake = (reason: string) => {
  lifecycle(polling ? `event ${reason}` : `wake ${reason}`);
  void pollLoop();
};

browser.runtime.onStartup.addListener(() => wake("onStartup"));
browser.runtime.onInstalled.addListener(() => wake("onInstalled"));
browser.alarms.onAlarm.addListener((alarm) => {
  wake(`alarm ${alarm.name}`);
  // Safari unloads a non-persistent background once it has not sent on a port for 2 minutes,
  // so each alarm sends on the native port. Incoming port messages and native polls do not count.
  // Posting on a disconnected port throws, so one that disconnected is opened again first.
  port ??= connect();
  port.postMessage({ kind: "keepalive", instance });
});
browser.tabs.onActivated.addListener(() => wake("tabs.onActivated"));
browser.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status === "complete") wake("tabs.onUpdated");
});
browser.tabs.onCreated.addListener(pilotOpened);
browser.tabs.onRemoved.addListener(forget);

// Lead (b): the app calls SFSafariApplication.dispatchMessage when a command is queued and no poll is open.
let connect = () => {
  let opened = browser.runtime.connectNative(appId);
  opened.onMessage.addListener((message) => {
    // Safari also delivers the app's reply to each keepalive here; only app dispatches are wakes.
    if (message?.ok) return;

    wake(`dispatch ${JSON.stringify(message)}`);
  });
  opened.onDisconnect.addListener(() => {
    if (port === opened) port = null;

    lifecycle("native port disconnected");
  });
  return opened;
};
let port: chrome.runtime.Port | null = connect();

void browser.alarms.create("keepalive", { periodInMinutes: 1 });
lifecycle("start");
restorePilotTabs().catch((error) =>
  lifecycle(`pilot tabs not restored: ${error}`),
);
void pollLoop();
