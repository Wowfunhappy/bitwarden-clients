import { ToastService } from "@bitwarden/components";

import { OffscreenDocumentService } from "../../offscreen-document/abstractions/offscreen-document";
import { safariLegacyClipboardService } from "../safari-legacy-clipboard.service";

import { BrowserPlatformUtilsService } from "./browser-platform-utils.service";

export class ForegroundPlatformUtilsService extends BrowserPlatformUtilsService {
  constructor(
    private toastService: ToastService,
    clipboardWriteCallback: (clipboardValue: string, clearMs: number) => void,
    win: Window & typeof globalThis,
    offscreenDocumentService: OffscreenDocumentService,
  ) {
    super(clipboardWriteCallback, win, offscreenDocumentService);

    // The popup is the only extension context that receives user input, and on the legacy Safari
    // port a clipboard write has to be rooted in one of its gestures.
    if (BrowserPlatformUtilsService.isSafariLegacy(win)) {
      safariLegacyClipboardService.trackUserGestures(win);
    }
  }

  override showToast(
    type: "error" | "success" | "warning" | "info",
    title: string,
    text: string | string[],
    options?: any,
  ): void {
    this.toastService._showToast({ type, title, text, options });
  }
}
