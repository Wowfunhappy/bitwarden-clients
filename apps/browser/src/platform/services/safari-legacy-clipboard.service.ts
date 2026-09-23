import BrowserClipboardService from "./browser-clipboard.service";

/**
 * How long after a gesture a write is still accepted into the queue. Kept below the length of
 * the timer chain so that a write accepted at the very end of a window still has a tick left to
 * carry it out.
 */
const GESTURE_WINDOW_MS = 850;

/**
 * How long the timer chain runs. WebKit reinstates the user gesture that installed a timer for
 * one second (`UserGestureToken::maximumIntervalForUserGestureForwarding`), so the chain stops
 * short of that rather than attempting a write the host rejects.
 */
const GESTURE_CHAIN_MS = 900;

/** How often a queued write is looked for while the chain runs. */
const POLL_INTERVAL_MS = 50;

interface QueuedWrite {
  win: Window;
  text: string;
  expiresAt: number;
  onWritten: () => void;
}

/**
 * Clipboard writes for the legacy Safari port, which allows them only while a user gesture is
 * being processed.
 *
 * A gesture lasts no longer than the handler that received it, so a value awaited from the global
 * page — a TOTP code, or the code an autofill returns — arrives too late for the handler's own
 * gesture to cover it. WebKit does forward a gesture to timers installed while it is still
 * active, and re-forwards it to timers those timers install, so each click here opens a window:
 * a chain of timers, rooted in the gesture, that carries out whichever write is queued over the
 * following second. A write with no window open is carried out directly, which is all the host
 * allows at that point.
 */
class SafariLegacyClipboardService {
  private queued: QueuedWrite | null = null;
  private acceptUntil = 0;

  /**
   * Opens a gesture window on every click in the given document. Call this for a document that
   * receives user input; the global page never does.
   */
  trackUserGestures(win: Window) {
    // Capture phase, so the window is open before any handler that copies can run.
    win.document.addEventListener("click", () => this.openGestureWindow(win), true);
  }

  /**
   * Writes text to the clipboard, waiting for the current gesture window when one is open.
   */
  write(win: Window, text: string, onWritten: () => void) {
    const now = Date.now();

    if (now < this.acceptUntil) {
      this.queued = { win, text, expiresAt: this.acceptUntil, onWritten };
      return;
    }

    this.copy({ win, text, expiresAt: now, onWritten });
  }

  private openGestureWindow(win: Window) {
    const now = Date.now();
    this.acceptUntil = now + GESTURE_WINDOW_MS;
    this.runChain(win, now + GESTURE_CHAIN_MS);
  }

  /**
   * Polls for a queued write until the gesture this chain was started from expires. Each timer is
   * installed from within the previous timer's callback, where the forwarded gesture is active
   * again, which carries the gesture across the whole chain.
   */
  private runChain(win: Window, expiresAt: number) {
    const tick = () => {
      const queued = this.queued;

      if (queued != null) {
        this.queued = null;

        // A write left over from an earlier, lapsed window would land on the clipboard long
        // after the action that asked for it, so drop it instead.
        if (Date.now() <= queued.expiresAt) {
          this.copy(queued);
        }

        return;
      }

      if (Date.now() + POLL_INTERVAL_MS > expiresAt) {
        return;
      }

      win.setTimeout(tick, POLL_INTERVAL_MS);
    };

    win.setTimeout(tick, 0);
  }

  private copy({ win, text, onWritten }: QueuedWrite) {
    void BrowserClipboardService.copy(win, text, { preferLegacy: true }).then(onWritten);
  }
}

export const safariLegacyClipboardService = new SafariLegacyClipboardService();
