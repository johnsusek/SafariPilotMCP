import type { CommandResponse, FrameNode } from "../shared/commands";
import type {
  ContentRequest,
  ContentResponse,
  Failure,
} from "../shared/protocol";
import { loadAfter } from "./load";
import type { NativeCommand } from "./native";
import { allTabs, resolveTab, tabInfo } from "./tabs";

let frameTimeoutMs = 2000;
let maxFrameDepth = 3;

// frameId 0 is the top frame; with content scripts in every frame, a send without one would take whichever frame answers first.
async function sendToContent(
  tabId: number | null,
  request: ContentRequest,
  frameId = 0,
): Promise<ContentResponse> {
  let tab = await resolveTab(tabId);
  let where =
    frameId === 0 ? `tab ${tab.id}` : `frame ${frameId} of tab ${tab.id}`;
  let noScript = `no content script answered in ${where} (${tab.url ?? "unknown url"}); open the URL in a new tab (tabs from before the extension was installed or updated stay unreachable), or the page does not allow extensions`;
  let response = await browser.tabs
    .sendMessage(tab.id, request, { frameId })
    .catch((error) => ({ ok: false as const, error: `${noScript}: ${error}` }));
  return (
    (response as ContentResponse | undefined) ?? {
      ok: false,
      error: noScript,
    }
  );
}

async function frameNode(
  tabId: number,
  frameId: number,
  depth: number,
): Promise<FrameNode> {
  let timeout = new Promise<Failure>((resolve) =>
    setTimeout(
      () =>
        resolve({ ok: false, error: `no answer within ${frameTimeoutMs} ms` }),
      frameTimeoutMs,
    ),
  );
  let listed = await Promise.race([
    sendToContent(tabId, { op: "frames" }, frameId),
    timeout,
  ]);
  let node: FrameNode = {
    frameId,
    error: null,
    url: "",
    title: "",
    clicks: 0,
    keydowns: 0,
    frames: [],
  };

  if (!listed.ok || !("frames" in listed)) {
    node.error = listed.ok ? "unexpected reply" : listed.error;
    return node;
  }

  let logged = await sendToContent(
    tabId,
    { op: "events", clear: true, arm: false },
    frameId,
  );
  let events = logged.ok && "events" in logged ? logged.events : [];
  let trusted = (type: string) =>
    events
      .filter((event) => event.type === type && event.isTrusted)
      .reduce((sum, event) => sum + event.count, 0);
  node.url = listed.url;
  node.title = listed.title;
  node.clicks = trusted("click");
  node.keydowns = trusted("keydown");
  node.frames = await Promise.all(
    listed.frames.map(async (entry) => ({
      ...entry,
      frame:
        entry.frameId >= 0 && depth < maxFrameDepth
          ? await frameNode(tabId, entry.frameId, depth + 1)
          : null,
    })),
  );
  return node;
}

async function loadedTab(start: () => Promise<number>) {
  let tabId = await loadAfter(start);
  return { ok: true as const, tab: await tabInfo(await resolveTab(tabId)) };
}

async function dispatch(command: NativeCommand): Promise<CommandResponse> {
  if (command.type === "content")
    return await sendToContent(command.tabId, command.request);

  if (command.type === "tabs") return { ok: true, tabs: await allTabs() };

  if (command.type === "frames") {
    let tab = await resolveTab(command.tabId);
    return { ok: true, tree: await frameNode(tab.id, 0, 0) };
  }

  if (command.type === "tab")
    return { ok: true, tab: await tabInfo(await resolveTab(command.tabId)) };

  if (command.type === "tabCreate") {
    // windowId is the caller's own window; with none, or once it is closed, a new unfocused window holds the tab.
    let url = command.url ?? undefined;
    let window =
      command.windowId === null
        ? null
        : await browser.windows.get(command.windowId).catch(() => null);
    let create = async () => {
      if (window)
        return (await browser.tabs.create({ windowId: window.id, url })).id!;

      let created = await browser.windows.create({ url, focused: false });
      return created!.tabs![0].id!;
    };

    if (command.url !== null) return await loadedTab(create);

    return { ok: true, tab: await tabInfo(await resolveTab(await create())) };
  }

  if (command.type === "tabSelect") {
    let tab = await resolveTab(command.tabId);
    await browser.tabs.update(tab.id, { active: true });
    return { ok: true, tab: await tabInfo(await resolveTab(tab.id)) };
  }

  if (command.type === "tabClose") {
    let tab = await resolveTab(command.tabId);
    await browser.tabs.remove(tab.id);
    return { ok: true, closed: tab.id };
  }

  if (command.type === "navigate") {
    let tab = await resolveTab(command.tabId);
    return await loadedTab(async () => {
      await browser.tabs.update(tab.id, { url: command.url });
      return tab.id;
    });
  }

  if (command.type === "history") {
    let tab = await resolveTab(command.tabId);
    return await loadedTab(async () => {
      await (command.direction === "back"
        ? browser.tabs.goBack(tab.id)
        : browser.tabs.goForward(tab.id));
      return tab.id;
    });
  }

  if (command.type === "resize") {
    let tab = await resolveTab(command.tabId);
    await browser.windows.update(tab.windowId, {
      width: command.width,
      height: command.height,
    });
    return { ok: true, tab: await tabInfo(await resolveTab(tab.id)) };
  }

  let tab = await resolveTab(command.tabId);

  if (!tab.active)
    return {
      ok: false,
      error: `tab ${tab.id} is not the active tab of its window; select it first`,
    };

  let dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  return { ok: true, dataUrl, tab: await tabInfo(tab) };
}

export async function runCommand(
  command: NativeCommand,
): Promise<CommandResponse> {
  try {
    return await dispatch(command);
  } catch (error) {
    return {
      ok: false,
      error: `${command.type} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
