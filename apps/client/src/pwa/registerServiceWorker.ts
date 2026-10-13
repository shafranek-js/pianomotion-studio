export interface ServiceWorkerRegistrationCallbacks {
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
  onSuccess?: (registration: ServiceWorkerRegistration) => void;
}

/**
 * Registers the PWA service worker with scope '/' and sets up lifecycle listeners.
 */
export async function registerServiceWorker(
  callbacks?: ServiceWorkerRegistrationCallbacks,
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    registration.addEventListener("updatefound", () => {
      const installingWorker = registration.installing;
      if (!installingWorker) {
        return;
      }

      installingWorker.addEventListener("statechange", () => {
        if (installingWorker.state === "installed") {
          if (navigator.serviceWorker.controller) {
            // New content is available; update can be triggered
            window.dispatchEvent(
              new CustomEvent("sw-update-available", {
                detail: { registration },
              }),
            );
            callbacks?.onUpdate?.(registration);
          } else {
            // Core shell assets are cached for offline availability
            window.dispatchEvent(
              new CustomEvent("sw-installed", {
                detail: { registration },
              }),
            );
            callbacks?.onSuccess?.(registration);
          }
        }
      });
    });

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
