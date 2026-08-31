import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/public/js/lib/api.js", () => ({
  sendDoctorCardFix: vi.fn(),
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import { sendDoctorCardFix } from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import {
  DoctorFixCardModal,
  kDoctorFixSessionFilter,
} from "../../lib/public/js/components/doctor/fix-card-modal.js";
import { AgentSendModal } from "../../lib/public/js/components/agent-send-modal.js";

const makeCard = (overrides = {}) => ({
  id: 7,
  fixPrompt: "Fix the drift in AGENTS.md",
  status: "open",
  ...overrides,
});

// Stateless wrapper: invoking it returns the AgentSendModal vnode directly
// (no DOM renderer needed — saved-toggle-component.test.js pattern).
const renderModal = (props = {}) =>
  DoctorFixCardModal({
    visible: true,
    card: makeCard(),
    onClose: () => {},
    onComplete: async () => {},
    ...props,
  });

describe("frontend/doctor fix-card modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders AgentSendModal with the destination session filter and hint", () => {
    const vnode = renderModal();
    expect(vnode.type).toBe(AgentSendModal);
    expect(vnode.props.sessionFilter).toBe(kDoctorFixSessionFilter);
    expect(typeof vnode.props.renderSessionHint).toBe("function");
    expect(vnode.props.initialMessage).toBe("Fix the drift in AGENTS.md");
  });

  it("filters to deliverable + main sessions, dropping cron/hook/doctor/subagent noise", () => {
    const rows = [
      { key: "agent:main:main", replyChannel: "", replyTo: "" },
      { key: "agent:main:telegram:direct:1050", replyChannel: "telegram", replyTo: "1050" },
      { key: "agent:main:discord:direct:99", replyChannel: "discord", replyTo: "user:99" },
      // Destination-shaped key even without reply metadata (cached rows).
      { key: "agent:main:telegram:group:-5", replyChannel: "", replyTo: "" },
      { key: "agent:main:doctor:42", replyChannel: "", replyTo: "" },
      { key: "agent:main:cron:abc", replyChannel: "", replyTo: "" },
      { key: "agent:main:hook:x", replyChannel: "", replyTo: "" },
      { key: "agent:main:subagent:s1", replyChannel: "", replyTo: "" },
    ];
    expect(rows.filter(kDoctorFixSessionFilter).map((row) => row.key)).toEqual([
      "agent:main:main",
      "agent:main:telegram:direct:1050",
      "agent:main:discord:direct:99",
      "agent:main:telegram:group:-5",
    ]);
  });

  it("renders the delivers-to hint from the selected row's deliverable flag", () => {
    const vnode = renderModal();
    const deliverableHint = vnode.props.renderSessionHint({
      key: "agent:main:telegram:direct:1050",
      deliverable: true,
      replyChannel: "telegram",
      replyTo: "1050",
    });
    expect(JSON.stringify(deliverableHint)).toContain("Delivers the outcome to this chat");
    const mainHint = vnode.props.renderSessionHint({
      key: "agent:main:main",
      deliverable: false,
    });
    expect(JSON.stringify(mainHint)).toContain("Runs in the main session");
    expect(vnode.props.renderSessionHint(null)).toBeNull();
  });

  it("forwards the selected row's reply fields verbatim and toasts 'requested' on attached delivery", async () => {
    sendDoctorCardFix.mockResolvedValue({
      ok: true,
      queued: true,
      delivery: { attached: true, replyChannel: "telegram", replyTo: "1050" },
    });
    const onComplete = vi.fn(async () => {});
    const vnode = renderModal({ onComplete });

    const shouldClose = await vnode.props.onSubmit({
      selectedSession: {
        key: "agent:main:telegram:direct:1050",
        replyChannel: "telegram",
        replyTo: "1050",
      },
      selectedSessionKey: "agent:main:telegram:direct:1050",
      message: "please fix",
    });

    expect(shouldClose).toBe(true);
    expect(sendDoctorCardFix).toHaveBeenCalledWith({
      cardId: 7,
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "please fix",
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const [toastText, toastTone] = showToast.mock.calls[0];
    expect(toastText).toContain("delivery to the selected chat requested");
    expect(toastText).not.toContain("delivered");
    expect(toastTone).toBe("success");
  });

  it("toasts the main-session copy when delivery was not attached", async () => {
    sendDoctorCardFix.mockResolvedValue({
      ok: true,
      queued: true,
      delivery: { attached: false, replyChannel: "", replyTo: "" },
    });
    const vnode = renderModal();

    await vnode.props.onSubmit({
      selectedSession: { key: "agent:main:main", replyChannel: "", replyTo: "" },
      selectedSessionKey: "agent:main:main",
      message: "fix in main",
    });

    const [toastText] = showToast.mock.calls[0];
    expect(toastText).toContain("queued to the main session");
    expect(toastText).toContain("Chat tab");
  });

  it("keeps the modal open and toasts the error on a failed dispatch", async () => {
    sendDoctorCardFix.mockRejectedValue(new Error("Selected session was not found"));
    const vnode = renderModal();

    const shouldClose = await vnode.props.onSubmit({
      selectedSession: { key: "agent:main:telegram:direct:9" },
      selectedSessionKey: "agent:main:telegram:direct:9",
      message: "x",
    });

    expect(shouldClose).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Selected session was not found", "error");
  });
});

describe("frontend/doctor fix-card modal review-batch regressions", () => {
  it("hints correctly for destination-shaped rows without reply metadata (derives from the key)", () => {
    const vnode = renderModal();
    // Cached/older row: no deliverable flag, no reply fields — the hint must
    // derive deliverability from the key, not claim 'main session'.
    const derivedHint = vnode.props.renderSessionHint({
      key: "agent:main:telegram:group:-5",
    });
    expect(JSON.stringify(derivedHint)).toContain("Delivers the outcome to this chat");
    // Explicitly non-deliverable non-main row: honest 'this session' copy.
    const sessionHint = vnode.props.renderSessionHint({
      key: "agent:main:clickclack:direct:77",
      deliverable: false,
    });
    expect(JSON.stringify(sessionHint)).toContain("Runs in this session");
    expect(JSON.stringify(sessionHint)).not.toContain("main session");
  });

  it("keeps main-session filtering suffix-tolerant via the canonical parser", () => {
    // The old hand-rolled /^agent:[^:]+:main$/ was $-anchored; the canonical
    // getSessionKind treats ':main'-suffixed keys as main.
    expect(kDoctorFixSessionFilter({ key: "agent:main:main" })).toBe(true);
    expect(kDoctorFixSessionFilter({ key: "agent:scout:main" })).toBe(true);
    expect(kDoctorFixSessionFilter({ key: "agent:main:doctor:42" })).toBe(false);
  });
});
