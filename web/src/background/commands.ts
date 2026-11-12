import type { ContentResponse } from "../shared/protocol";
import type { CommandResponse, NativeCommand } from "./native";

let targetTab = async () => {
  let [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (tab?.id === undefined)
    throw new Error("no active tab in the last focused window");

  return tab;
};

export let runCommand = async (
  command: NativeCommand,
): Promise<CommandResponse> => {
  try {
    if (command.type === "content") {
      let tab = await targetTab();
      return (await browser.tabs.sendMessage(
        tab.id!,
        command.request,
      )) as ContentResponse;
    }

    if (command.type === "tabs") {
      let tabs = await browser.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((tab) => ({
          id: tab.id ?? -1,
          windowId: tab.windowId,
          active: tab.active,
          url: tab.url ?? "",
          title: tab.title ?? "",
        })),
      };
    }

    if (command.type === "navigate") {
      let tab = await targetTab();
      await browser.tabs.update(tab.id!, { url: command.url });
      return { ok: true, tabId: tab.id!, url: command.url };
    }

    let tab = await targetTab();
    let dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};
