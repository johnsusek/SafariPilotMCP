import type { CommandResponse, FrameNode } from "../shared/commands";
import { redactUrl } from "../shared/redact";
import type {
  ContentRequest,
  ContentResponse,
  FramesResult,
} from "../shared/protocol";
import { accessFailure, accessFrom, probeAccess, refusing } from "./access";
import type { Failure } from "../shared/protocol";
import {
  failureFrom,
  maxFrameDepth,
  type Send,
  thrown,
  timed,
  withTimeout,
} from "./frames";
import { runJavascript } from "./javascript";
import { loadAfter, loadTimeoutMs, settle } from "./load";
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
  let noScript = `no content script answered in ${where} (${tab.url === undefined ? "unknown url" : redactUrl(tab.url)}); open the URL in a new tab (tabs from before the extension was installed or updated stay unreachable), or the page does not allow extensions`;
  let response = browser.tabs
    .sendMessage(tab.id, request, { frameId })
    .then(
      (answer): ContentResponse =>
        (answer as ContentResponse | undefined) ?? {
          ok: false,
          error: noScript,
          code: "no_content_script",
        },
      (error): ContentResponse => ({
        ok: false,
        error: `${noScript}: ${error}`,
        code: "no_content_script",
      }),
    )
    .then(async (reply) => {
      // Safari injects no content script on a site it has not granted, so a silent top frame may be that rather than a tab older than the extension.
      if (reply.ok || reply.code !== "no_content_script" || frameId !== 0)
        return reply;

      let access = await probeAccess(tab.id);

      if (access === "prompt" || access === "denied")
        throw thrown(accessFailure(access, tab.id, tab.url));

      return reply;
    });
  return await withTimeout(
    response,
    contentTimeoutMs,
    `no answer from ${where} within ${contentTimeoutMs / 1000} s; the page is busy`,
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

type KnownTab = chrome.tabs.Tab & { id: number };

// A navigation that is still loading after the timeout fails; a created tab is answered as loading instead, since it exists and its caller must come to own it.
// start answers with the tab as known before the load. When Safari holds the loaded tab behind its website access prompt, the load is still reported, with that tab
// and access set, since the navigation happened and the caller should ask its user rather than repeat it.
async function loadedTab(start: () => Promise<KnownTab>, created = false) {
  let known: KnownTab | undefined;
  let { tabId, loaded } = await loadAfter(async () => {
    known = await start();
    return known.id;
  });

  if (!loaded && !created)
    throw thrown({
      ok: false,
      error: `tab ${tabId} did not finish loading within ${loadTimeoutMs / 1000} s`,
      code: "timed_out",
    });

  let tab = known!;
  let access: Failure | null = null;

  try {
    tab = await resolveTab(tabId);
  } catch (error) {
    access = accessFrom(error);

    if (!access) throw error;
  }

  return {
    ok: true as const,
    tab: await tabInfo(tab),
    loading: !loaded,
    ...(access && { access }),
  };
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

  if (command.type === "javascript") {
    let tab = await resolveTab(command.tabId);
    return await runJavascript(
      tab.id,
      await sender(tab.id),
      command.code,
      command.frame,
    ).catch(refusing(tab.id, tab.url));
  }

  if (command.type === "tab")
    return { ok: true, tab: await tabInfo(await resolveTab(command.tabId)) };

  if (command.type === "tabCreate") {
    // Every session shares one pilot window; session storage forgets it when Safari quits or the extension reloads, which renumber windows.
    let url = command.url ?? undefined;
    let { pilotWindow } = await browser.storage.session.get("pilotWindow");
    let window =
      typeof pilotWindow === "number"
        ? await browser.windows.get(pilotWindow).catch(() => null)
        : null;
    let create = async () => {
      if (window)
        return (await browser.tabs.create({
          windowId: window.id,
          url,
        })) as KnownTab;

      let created = await browser.windows.create({ url, focused: false });
      await browser.storage.session.set({ pilotWindow: created!.id });
      return created!.tabs![0] as KnownTab;
    };

    if (command.url !== null)
      return await loadedTab(
        async () => ({ ...(await create()), url: command.url! }),
        true,
      );

    return {
      ok: true,
      tab: await tabInfo(await resolveTab((await create()).id)),
    };
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
      return { ...tab, url: command.url, title: "" };
    });
  }

  if (command.type === "history") {
    let tab = await resolveTab(command.tabId);
    return await loadedTab(async () => {
      await (command.direction === "back"
        ? browser.tabs.goBack(tab.id)
        : browser.tabs.goForward(tab.id));
      return { ...tab, url: "", title: "" };
    });
  }

  if (command.type === "settle")
    return await settle(command.tabId, command.url, command.watchMs);

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
      code: "tab_unavailable",
    };

  let dataUrl = await browser.tabs
    .captureVisibleTab(tab.windowId, { format: "png" })
    .catch(refusing(tab.id, tab.url));
  return { ok: true, dataUrl, tab: await tabInfo(tab) };
}

export async function runCommand(
  command: NativeCommand,
): Promise<CommandResponse> {
  try {
    return await dispatch(command);
  } catch (error) {
    let failure = failureFrom(error);

    // An access failure is already worded for the user; others say which command failed.
    if (accessFrom(error)) return failure!;

    return {
      ok: false,
      error: `${command.type} failed: ${error instanceof Error ? error.message : String(error)}`,
      code: failure?.code ?? "failed",
    };
  }
}
