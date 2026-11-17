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
import { listRequests, piloting, requestDetail } from "./network";
import { runPageFetch } from "./pageFetch";
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
    // Each session has its own window, which never holds another session's tab or the user's. A window is trusted only while every tab in it is one of the session's (or the one being made),
    // since a renumbered id can name another window and Safari can put a new window's tab into an existing window.
    let url = command.url ?? undefined;
    let ownOnly = async (windowId: number | null, newTab?: number) => {
      if (windowId === null) return null;

      let found = await browser.windows
        .get(windowId, { populate: true })
        .catch(() => null);
      let only = found?.tabs?.every(
        (tab) => tab.id === newTab || command.own.includes(tab.id!),
      );
      return only ? found : null;
    };
    // As the front app Safari shows a new window over its others despite focused: false, so the window that was in front is focused again.
    // Never while Safari is behind another app, where focusing a window could bring Safari forward.
    let newWindow = async (data: { url?: string; tabId?: number }) => {
      let front = command.safariFrontmost
        ? await browser.windows.getLastFocused().catch(() => null)
        : null;
      let created = await browser.windows.create({ ...data, focused: false });

      // That window may have closed meanwhile (an orphan sweep right after launch), leaving nothing to focus.
      if (front)
        await browser.windows
          .update(front.id!, { focused: true })
          .catch(() => {});

      return created!.tabs![0] as KnownTab;
    };
    let window = await ownOnly(command.windowId);
    let create = () =>
      piloting(async () => {
        // Opened as a background tab: Safari brings a window in front of its others when an active tab opens in it. Input selects the tab when it needs to.
        let tab = window
          ? ((await browser.tabs.create({
              windowId: window.id,
              url,
              active: false,
            })) as KnownTab)
          : await newWindow({ url });

        if (!(await ownOnly(tab.windowId, tab.id)))
          tab = await newWindow({ tabId: tab.id });

        if (!(await ownOnly(tab.windowId, tab.id))) {
          await browser.tabs.remove(tab.id).catch(() => {});
          throw thrown({
            ok: false,
            error:
              "Safari put the new tab in a window with other tabs and would not move it to its own window, so it was closed",
            code: "failed",
          });
        }

        return tab;
      });

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

  if (command.type === "closeTabs") {
    await Promise.all(
      command.tabIds.map((id) => browser.tabs.remove(id).catch(() => {})),
    );
    return { ok: true };
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

  if (command.type === "network") {
    let tab = await resolveTab(command.tabId);
    return listRequests(
      tab.id,
      command.urlPattern,
      command.limit,
      command.clear,
    );
  }

  if (command.type === "networkRequest") {
    let tab = await resolveTab(command.tabId);
    return await requestDetail(await sender(tab.id), tab.id, command.requestId);
  }

  if (command.type === "pageFetch") {
    let tab = await resolveTab(command.tabId);
    return await runPageFetch(tab, await sender(tab.id), command.request);
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
