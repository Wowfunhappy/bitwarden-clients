import { ConsoleLogService } from "@bitwarden/common/platform/services/console-log.service";

class BrowserClipboardService {
  private static consoleLogService: ConsoleLogService = new ConsoleLogService(false);

  /**
   * Copies the given text to the user's clipboard.
   *
   * @param globalContext - The global window context.
   * @param text - The text to copy.
   */
  static async copy(globalContext: Window, text: string) {
    if (!BrowserClipboardService.isClipboardApiSupported(globalContext, "writeText")) {
      this.useLegacyCopyMethod(globalContext, text);
      return;
    }

    try {
      await globalContext.navigator.clipboard.writeText(text);
    } catch (error) {
      BrowserClipboardService.consoleLogService.debug(
        `Error copying to clipboard using the clipboard API, attempting legacy method: ${error}`,
      );

      this.useLegacyCopyMethod(globalContext, text);
    }
  }

  /**
   * Reads the user's clipboard and returns the text.
   *
   * @param globalContext - The global window context.
   */
  static async read(globalContext: Window): Promise<string> {
    if (!BrowserClipboardService.isClipboardApiSupported(globalContext, "readText")) {
      return this.useLegacyReadMethod(globalContext);
    }

    try {
      return await globalContext.navigator.clipboard.readText();
    } catch (error) {
      BrowserClipboardService.consoleLogService.debug(
        `Error reading from clipboard using the clipboard API, attempting legacy method: ${error}`,
      );

      return this.useLegacyReadMethod(globalContext);
    }
  }

  /**
   * Copies the given text to the user's clipboard using the legacy `execCommand` method. This
   * method is used as a fallback when the clipboard API is not supported or fails.
   *
   * @param globalContext - The global window context.
   * @param text - The text to copy.
   */
  private static useLegacyCopyMethod(globalContext: Window, text: string) {
    if (!BrowserClipboardService.isLegacyClipboardMethodSupported(globalContext, "copy")) {
      BrowserClipboardService.consoleLogService.warning("Legacy copy method not supported");
      return;
    }

    const textareaElement = globalContext.document.createElement("textarea");
    textareaElement.value = !text ? " " : text;
    // Keep the element in the layout (Safari will not copy from a detached or
    // display:none node) but out of sight.
    textareaElement.style.position = "fixed";
    textareaElement.style.top = "0";
    textareaElement.style.left = "0";
    textareaElement.style.width = "1px";
    textareaElement.style.height = "1px";
    textareaElement.style.opacity = "0";
    globalContext.document.body.appendChild(textareaElement);

    try {
      // Safari's `<textarea>.select()` alone does not reliably produce the
      // selection that `execCommand("copy")` reads from, so also focus the field
      // and set an explicit selection range.
      textareaElement.focus();
      textareaElement.select();
      textareaElement.setSelectionRange(0, textareaElement.value.length);

      if (!globalContext.document.execCommand("copy")) {
        BrowserClipboardService.consoleLogService.warning(
          "Legacy copy command returned false; the clipboard was not updated",
        );
      }
    } catch (error) {
      BrowserClipboardService.consoleLogService.warning(`Error writing to clipboard: ${error}`);
    } finally {
      globalContext.document.body.removeChild(textareaElement);
    }
  }

  /**
   * Reads the user's clipboard using the legacy `execCommand` method. This method is used as a
   * fallback when the clipboard API is not supported or fails.
   *
   * @param globalContext - The global window context.
   */
  private static useLegacyReadMethod(globalContext: Window): string {
    if (!BrowserClipboardService.isLegacyClipboardMethodSupported(globalContext, "paste")) {
      BrowserClipboardService.consoleLogService.warning("Legacy paste method not supported");
      return "";
    }

    const textareaElement = globalContext.document.createElement("textarea");
    textareaElement.style.position = "fixed";
    globalContext.document.body.appendChild(textareaElement);
    textareaElement.focus();

    try {
      return globalContext.document.execCommand("paste") ? textareaElement.value : "";
    } catch (error) {
      BrowserClipboardService.consoleLogService.warning(`Error reading from clipboard: ${error}`);
    } finally {
      globalContext.document.body.removeChild(textareaElement);
    }

    return "";
  }

  /**
   * Checks if the clipboard API is supported in the current environment.
   *
   * @param globalContext - The global window context.
   * @param method - The clipboard API method to check for support.
   */
  private static isClipboardApiSupported(globalContext: Window, method: "writeText" | "readText") {
    return "clipboard" in globalContext.navigator && method in globalContext.navigator.clipboard;
  }

  /**
   * Checks if the legacy clipboard method is supported in the current environment.
   *
   * @param globalContext - The global window context.
   * @param method - The legacy clipboard method to check for support.
   */
  private static isLegacyClipboardMethodSupported(globalContext: Window, method: "copy" | "paste") {
    return (
      "queryCommandSupported" in globalContext.document &&
      globalContext.document.queryCommandSupported(method)
    );
  }
}

export default BrowserClipboardService;
