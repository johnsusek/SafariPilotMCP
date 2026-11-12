import type { CommandResponse } from "../shared/commands";
import type { ContentRequest, ContentResponse } from "../shared/protocol";
import { loadAfter } from "./load";
import type { NativeCommand } from "./native";
import { allTabs, resolveTab, tabInfo } from "./tabs";

async function sendToContent(
  tabId: number | null,
  request: ContentRequest,
): Promise<ContentResponse> {
  let tab = await resolveTab(tabId);
  let noScript = `no content script answered in tab ${tab.id} (${tab.url ?? "unknown url"}); reload the tab, or the page does not allow extensions`;
  let response = await browser.tabs
    .sendMessage(tab.id, request)
    .catch((error) => ({ ok: false as const, error: `${noScript}: ${error}` }));
  return (
    (response as ContentResponse | undefined) ?? {
      ok: false,
      error: noScript,
    }
  );
}

async function loadedTab(start: () => Promise<number>) {
  let tabId = await loadAfter(start);
  return { ok: true as const, tab: await tabInfo(await resolveTab(tabId)) };
}

async function dispatch(command: NativeCommand): Promise<CommandResponse> {
  if (command.type === "content")
    return await sendToContent(command.tabId, command.request);

  if (command.type === "tabs") return { ok: true, tabs: await allTabs() };

  if (command.type === "tab")
    return { ok: true, tab: await tabInfo(await resolveTab(command.tabId)) };

  if (command.type === "tabCreate") {
    let { id: windowId } = await browser.windows.getLastFocused();
    let create = async () =>
      (await browser.tabs.create({ windowId, url: command.url ?? undefined }))
        .id!;

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
