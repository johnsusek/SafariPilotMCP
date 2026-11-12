import type { CommandResponse, FrameNode } from "../shared/commands";
import type {
  ContentRequest,
  ContentResponse,
  FramesResult,
} from "../shared/protocol";
import { maxFrameDepth, type Send, timed, withTimeout } from "./frames";
import { loadAfter } from "./load";
import type { NativeCommand } from "./native";
import { runPage } from "./page";
import { allTabs, resolveTab, tabInfo } from "./tabs";

// Longer than the slowest content op (locate settles for up to 3 s, read_page of a huge page takes seconds).
let contentTimeoutMs = 15000;

// frameId 0 is the top frame; with content scripts in every frame, a send without one would take whichever frame answers first.
async function sendToContent(
  tab: chrome.tabs.Tab & { id: number },
  request: ContentRequest,
  frameId: number,
): Promise<ContentResponse> {
  let where =
    frameId === 0 ? `tab ${tab.id}` : `frame ${frameId} of tab ${tab.id}`;
  let noScript = `no content script answered in ${where} (${tab.url ?? "unknown url"}); open the URL in a new tab (tabs from before the extension was installed or updated stay unreachable), or the page does not allow extensions`;
  let response = browser.tabs
    .sendMessage(tab.id, request, { frameId })
    .then(
      (answer) =>
        (answer as ContentResponse | undefined) ?? {
          ok: false as const,
          error: noScript,
        },
    )
    .catch((error) => ({ ok: false as const, error: `${noScript}: ${error}` }));
  return await withTimeout(
    response,
    contentTimeoutMs,
    `no answer from ${where} within ${contentTimeoutMs / 1000} s; a dialog such as alert() may be open in the page`,
  );
}

async function frameNode(
  send: Send,
  frameId: number,
  depth: number,
): Promise<FrameNode> {
  let listed = await timed(send, frameId, { op: "frames" });
  let node: FrameNode = {
    frameId,
    error: null,
    url: "",
    title: "",
    clicks: 0,
    keydowns: 0,
    frames: [],
  };

  if (!listed.ok) {
    node.error = listed.error;
    return node;
  }

  let logged = await send(frameId, {
    op: "events",
    clear: true,
    arm: false,
    watch: null,
  });
  let events = logged.ok && "events" in logged ? logged.events : [];
  let trusted = (type: string) =>
    events
      .filter((event) => event.type === type && event.isTrusted)
      .reduce((sum, event) => sum + event.count, 0);
  let { url, title, frames } = listed as FramesResult;
  node.url = url;
  node.title = title;
  node.clicks = trusted("click");
  node.keydowns = trusted("keydown");
  node.frames = await Promise.all(
    frames.map(async (entry) => ({
      ...entry,
      frame:
        entry.frameId >= 0 && depth < maxFrameDepth
          ? await frameNode(send, entry.frameId, depth + 1)
          : null,
    })),
  );
  return node;
}

async function loadedTab(start: () => Promise<number>) {
  let tabId = await loadAfter(start);
  return { ok: true as const, tab: await tabInfo(await resolveTab(tabId)) };
}

async function sender(tabId: number | null): Promise<Send> {
  let tab = await resolveTab(tabId);
  return async (frameId, request) => await sendToContent(tab, request, frameId);
}

async function dispatch(command: NativeCommand): Promise<CommandResponse> {
  if (command.type === "content")
    return await runPage(await sender(command.tabId), command.request);

  if (command.type === "tabs") return { ok: true, tabs: await allTabs() };

  if (command.type === "frames")
    return {
      ok: true,
      tree: await frameNode(await sender(command.tabId), 0, 0),
    };

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
