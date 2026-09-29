import { safariLegacyClipboardService } from "./safari-legacy-clipboard.service";

describe("SafariLegacyClipboardService", () => {
  it("waits for a successful host write before reporting it", async () => {
    let finishWrite: () => void;
    const writeText = jest.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    const onWritten = jest.fn();
    const win = { navigator: { clipboard: { writeText } } } as unknown as Window;

    const writing = safariLegacyClipboardService.write(win, "123456", onWritten);
    expect(writeText).toHaveBeenCalledWith("123456");
    expect(onWritten).not.toHaveBeenCalled();

    finishWrite();
    await writing;
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed host write as successful", async () => {
    const onWritten = jest.fn();
    const win = {
      navigator: { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) } },
    } as unknown as Window;

    await safariLegacyClipboardService.write(win, "123456", onWritten);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("reads from the host clipboard API", async () => {
    const readText = jest.fn().mockResolvedValue("123456");
    const win = { navigator: { clipboard: { readText } } } as unknown as Window;

    await expect(safariLegacyClipboardService.read(win)).resolves.toBe("123456");
  });
});
