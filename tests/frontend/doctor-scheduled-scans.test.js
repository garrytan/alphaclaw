import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/public/js/hooks/use-saved-setting.js", () => ({
  useSavedSetting: vi.fn(),
}));
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchDoctorSettings: vi.fn(),
  updateDoctorSettings: vi.fn(async () => ({ ok: true, settings: {} })),
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import { useSavedSetting } from "../../lib/public/js/hooks/use-saved-setting.js";
import { updateDoctorSettings } from "../../lib/public/js/lib/api.js";
import { DoctorScheduledScans } from "../../lib/public/js/components/doctor/scheduled-scans.js";

// Stateless-walk pattern (saved-toggle-component.test.js): child function
// components that use hooks fail to expand (rendered: null) but their vnode
// props stay inspectable — which is all these tests need.
const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

const kDoc = {
  autoRunEnabled: true,
  scan: { maxFiles: null, maxFileMb: 25 },
  scanEffective: { maxFiles: 200000, maxFileMb: 25 },
};

const makeSetting = (overrides = {}) => ({
  value: kDoc,
  hydrated: true,
  saving: false,
  savingContext: null,
  saveError: null,
  loadError: null,
  retryLoad: vi.fn(),
  commit: vi.fn(async () => ({ ok: true })),
  ...overrides,
});

const renderCard = ({ setting = makeSetting(), doctorStatus } = {}) => {
  useSavedSetting.mockReturnValue(setting);
  const tree = expandTree(
    DoctorScheduledScans({
      doctorStatus: doctorStatus ?? {
        autoRun: { enabled: true },
        workspaceScan: { stats: { totalFiles: 4321 } },
      },
    }),
  );
  return { tree, setting, hookConfig: useSavedSetting.mock.calls.at(-1)[0] };
};

const scanInputByLabel = (tree, label) =>
  collectNodes(tree).find(
    (vnode) => typeof vnode.type === "function" && vnode.props?.label === label,
  );

describe("frontend/doctor scheduled-scans settings card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses ONE hook for the whole settings document and narrows PUT bodies per context", async () => {
    const { hookConfig } = renderCard();
    expect(useSavedSetting).toHaveBeenCalledTimes(1);

    // Scan-context save: body carries ONLY the single edited cap — neither a
    // stale autoRun copy nor a stale SIBLING cap may ride along (another
    // tab/API client could have changed them after this tab loaded).
    await hookConfig.save(
      { autoRunEnabled: true, scan: { maxFiles: 300000, maxFileMb: 25 } },
      { context: "scan:maxFiles" },
    );
    expect(updateDoctorSettings).toHaveBeenLastCalledWith({
      scan: { maxFiles: 300000 },
    });

    await hookConfig.save(
      { autoRunEnabled: true, scan: { maxFiles: 300000, maxFileMb: null } },
      { context: "scan:maxFileMb" },
    );
    expect(updateDoctorSettings).toHaveBeenLastCalledWith({
      scan: { maxFileMb: null },
    });

    await hookConfig.save(
      { autoRunEnabled: false, scan: { maxFiles: 300000, maxFileMb: 25 } },
      { context: "autoRun" },
    );
    expect(updateDoctorSettings).toHaveBeenLastCalledWith({ autoRunEnabled: false });
  });

  it("selects the {configured, effective} settings document shape", () => {
    const { hookConfig } = renderCard();
    expect(
      hookConfig.select({
        settings: {
          autoRunEnabled: true,
          scan: {
            maxFiles: { configured: 5000, effective: 5000 },
            maxFileMb: { configured: null, effective: 50 },
          },
        },
      }),
    ).toEqual({
      autoRunEnabled: true,
      scan: { maxFiles: 5000, maxFileMb: null },
      scanEffective: { maxFiles: 5000, maxFileMb: 50 },
    });
  });

  it("commits a scan-limit change with the scan context and the sibling cap preserved", async () => {
    const { tree, setting } = renderCard();
    const maxFilesInput = scanInputByLabel(tree, "Max files");
    expect(maxFilesInput).toBeTruthy();

    await maxFilesInput.props.onCommit(300000);
    expect(setting.commit).toHaveBeenCalledWith(
      { ...kDoc, scan: { maxFiles: 300000, maxFileMb: 25 } },
      { context: "scan:maxFiles" },
    );
  });

  it("shows the current workspace file count beside the max-files input (d6)", () => {
    const { tree } = renderCard();
    const maxFilesInput = scanInputByLabel(tree, "Max files");
    expect(maxFilesInput.props.hint).toBe("Current workspace: 4,321 files");
    expect(maxFilesInput.props.effective).toBe(200000);
  });

  it("anchors the card for the banner deep link (d4)", () => {
    const { tree } = renderCard();
    const anchored = collectNodes(tree).find(
      (vnode) => vnode.props?.id === "doctor-scan-limits",
    );
    expect(anchored).toBeTruthy();
  });
});

describe("frontend/doctor scheduled-scans review-batch regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parseScanInputValue: blank resets, numbers parse, junk passes through for a loud server 400", async () => {
    const { parseScanInputValue } = await import(
      "../../lib/public/js/components/doctor/scheduled-scans.js"
    );
    expect(parseScanInputValue("")).toBeNull();
    expect(parseScanInputValue("   ")).toBeNull();
    expect(parseScanInputValue("300000")).toBe(300000);
    expect(parseScanInputValue(" 42 ")).toBe(42);
    expect(parseScanInputValue("1.5")).toBe(1.5);
    // Non-numeric input reaches the server verbatim so the 400/revert flow
    // (not a silent client-side swallow) surfaces the mistake.
    expect(parseScanInputValue("many")).toBe("many");
  });

  it("save-error chip copy keys on the attempted DOC's autoRunEnabled (regression: doc object is always truthy)", () => {
    const { tree } = renderCard();
    const savedToggle = collectNodes(tree).find(
      (vnode) => typeof vnode.type === "function" && vnode.props?.describe,
    );
    expect(savedToggle).toBeTruthy();
    const describe = savedToggle.props.describe;
    expect(describe({ autoRunEnabled: true, scan: {} })).toContain("Couldn't enable");
    // Pre-fix regression shape: a truthy doc with autoRunEnabled:false must
    // render the DISABLE headline, not fall into the enable branch.
    expect(describe({ autoRunEnabled: false, scan: {} })).toContain("Couldn't disable");
  });
});
