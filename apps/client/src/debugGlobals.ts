/**
 * Debug globals (`window.__m1LastResult`, `window.__playerSnapshot`, …) are a
 * development/test hook. Keep them out of normal production pages, while
 * leaving them available to the browser test runner.
 */
export function isDebugGlobalsEnabled(dev: boolean, webdriver: boolean | undefined): boolean {
  return dev || webdriver === true;
}

export function debugGlobalsEnabled(): boolean {
  const webdriver = typeof navigator === "undefined" ? undefined : navigator.webdriver;
  return isDebugGlobalsEnabled(import.meta.env.DEV, webdriver);
}
