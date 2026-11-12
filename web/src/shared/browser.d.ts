// @types/chrome lacks runtime.getFrameId, which Safari has had since 16.
declare let browser: typeof chrome & {
  runtime: typeof chrome.runtime & {
    getFrameId(target: Element | Window): number;
  };
};
