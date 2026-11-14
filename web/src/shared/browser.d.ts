// @types/chrome lacks runtime.getFrameId, which Safari has had since 16.
declare let browser: typeof chrome & {
  runtime: typeof chrome.runtime & {
    getFrameId(target: Element | Window): number;
  };
};
// Safari 18.2+; lib ES2022 does not declare it yet.
interface Uint8ArrayConstructor {
  fromBase64(text: string): Uint8Array<ArrayBuffer>;
}
// Defined by web/build.mjs for the background bundle.
declare let SAFARIPILOT_BUILD: string;
