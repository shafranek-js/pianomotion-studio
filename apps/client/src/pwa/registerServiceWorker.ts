import { appBaseUrl, applicationBuildId } from "./urls";

let currentRegistration: ServiceWorkerRegistration | null = null;

export function getCurrentServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return currentRegistration;
}

/** Retire only this app's old dev-origin registration; keep caches and IndexedDB. */
export async function unregisterDevelopmentServiceWorker(): Promise<void> {
  if (!import.meta.env.DEV || typeof navigator === "undefined" || !navigator.serviceWorker?.getRegistrations) return;
  const scope = appBaseUrl().href;
  const workerUrl = appBaseUrl("sw.js").href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.filter(registration => registration.scope === scope &&
    [registration.active, registration.installing, registration.waiting].some(worker => worker?.scriptURL === workerUrl),
  ).map(registration => registration.unregister()));
}

export interface ServiceWorkerRegistrationCallbacks {
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
  onSuccess?: (registration: ServiceWorkerRegistration) => void;
}

/**
 * Registers the PWA service worker with scope according to base path and sets up lifecycle listeners.
 * Only registers in production mode.
 */
export async function registerServiceWorker(
  callbacks?: ServiceWorkerRegistrationCallbacks,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  // Never register service worker in development mode
  if (import.meta.env.DEV) {
    return null;
  }

  try {
    const baseUrl = appBaseUrl();
    const scopePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
    const swUrl = appBaseUrl("sw.js").href;
    const notifiedWorkers = new WeakSet<ServiceWorker>();

    const reportInstalledWorker = (worker: ServiceWorker) => {
      if (worker.state !== "installed" || notifiedWorkers.has(worker)) {
        return;
      }
      notifiedWorkers.add(worker);
      if (navigator.serviceWorker.controller) {
        window.dispatchEvent(new CustomEvent("sw-update-available", { detail: { registration } }));
        callbacks?.onUpdate?.(registration);
      } else {
        window.dispatchEvent(new CustomEvent("sw-installed", { detail: { registration } }));
        callbacks?.onSuccess?.(registration);
      }
    };

    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: scopePath,
      updateViaCache: "none",
    });
    currentRegistration = registration;

    const watchInstallingWorker = () => {
      const installingWorker = registration.installing;
      if (!installingWorker) {
        return;
      }
      reportInstalledWorker(installingWorker);
      installingWorker.addEventListener("statechange", () => {
        reportInstalledWorker(installingWorker);
      });
    };

    registration.addEventListener("updatefound", watchInstallingWorker);
    watchInstallingWorker();

    const pinBuildForCurrentController = () => {
      navigator.serviceWorker.controller?.postMessage({
        type: "PIN_BUILD",
        buildId: applicationBuildId(),
      });
    };
    pinBuildForCurrentController();
    navigator.serviceWorker.addEventListener("controllerchange", pinBuildForCurrentController);

    // A page opened after an update was previously installed still needs to surface that waiting worker.
    if (registration.waiting) {
      reportInstalledWorker(registration.waiting);
    }

    return registration;
  } catch (error) {
    console.error("Service worker registration failed:", error);
    return null;
  }
}

/**
 * Sends SKIP_WAITING to a waiting service worker to activate it immediately.
 */
export function skipWaiting(registration?: ServiceWorkerRegistration | null): void {
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
}
