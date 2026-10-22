import { showToast } from "../../lib/public/js/components/toast.js";

vi.mock("../../lib/public/js/components/toast.js", () => ({ showToast: vi.fn() }));

const loadClipboardModule = async () => import("../../lib/public/js/lib/clipboard.js");

describe("frontend/clipboard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
    });

    const { copyTextToClipboard } = await loadClipboardModule();

    await expect(copyTextToClipboard("workspace/docs/readme.md")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("workspace/docs/readme.md");
  });

  it("falls back to document.execCommand when clipboard API is unavailable", async () => {
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const select = vi.fn();
    const setAttribute = vi.fn();
    const fallbackElement = {
      value: "",
      style: {},
      select,
      setAttribute,
    };

    vi.stubGlobal("document", {
      createElement: vi.fn(() => fallbackElement),
      execCommand: vi.fn(() => true),
      body: {
        appendChild,
        removeChild,
      },
    });

    const { copyTextToClipboard } = await loadClipboardModule();

    await expect(copyTextToClipboard("workspace/config.json")).resolves.toBe(true);
    expect(global.document.createElement).toHaveBeenCalledWith("textarea");
    expect(setAttribute).toHaveBeenCalledWith("readonly", "");
    expect(select).toHaveBeenCalledTimes(1);
    expect(global.document.execCommand).toHaveBeenCalledWith("copy");
    expect(appendChild).toHaveBeenCalledWith(fallbackElement);
    expect(removeChild).toHaveBeenCalledWith(fallbackElement);
  });

  it("returns false when there is no text to copy", async () => {
    const { copyTextToClipboard } = await loadClipboardModule();

    await expect(copyTextToClipboard("")).resolves.toBe(false);
  });
});

describe("frontend/clipboard copyWithToast", () => {
  const fallbackDocument = (execCommand) => ({
    createElement: vi.fn(() => ({ value: "", style: {}, select: vi.fn(), setAttribute: vi.fn() })),
    execCommand,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    showToast.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toasts success when the copy lands", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { copyWithToast } = await loadClipboardModule();
    await copyWithToast("npm install -g openclaw", "command");
    expect(showToast).toHaveBeenCalledWith("Copied to clipboard", "success");
  });

  it("toasts the failure when the execCommand fallback returns false", async () => {
    vi.stubGlobal("document", fallbackDocument(vi.fn(() => false)));
    const { copyWithToast } = await loadClipboardModule();
    await copyWithToast("gcloud auth login", "command");
    expect(showToast).toHaveBeenCalledWith("Could not copy command", "error");
  });

  it("toasts the failure when the execCommand fallback throws", async () => {
    vi.stubGlobal("document", fallbackDocument(vi.fn(() => { throw new Error("denied"); })));
    const { copyWithToast } = await loadClipboardModule();
    await copyWithToast("gcloud auth login");
    expect(showToast).toHaveBeenCalledWith("Could not copy text", "error");
  });
});
