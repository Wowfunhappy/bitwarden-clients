import { ConsoleLogService } from "@bitwarden/common/platform/services/console-log.service";

/** Clipboard access for the custom WebKit host's extension pages. */
class SafariLegacyClipboardService {
  private readonly logService = new ConsoleLogService(false);

  async write(win: Window, text: string, onWritten: () => void): Promise<void> {
    try {
      await win.navigator.clipboard.writeText(text);
    } catch (error) {
      this.logService.warning(`Error writing to clipboard: ${error}`);
      return;
    }

    onWritten();
  }

  read(win: Window): Promise<string> {
    return win.navigator.clipboard.readText();
  }
}

export const safariLegacyClipboardService = new SafariLegacyClipboardService();
