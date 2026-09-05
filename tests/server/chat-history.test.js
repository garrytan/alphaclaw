const { normalizeHistoryContent } = require("../../lib/server/chat/history");

// Fix wave F116: typed non-text parts (image/audio/file) must never be
// scraped into the transcript row — the `type` literal, MIME type and base64
// payload used to land in the visible text.
describe("server/chat/history normalizeHistoryContent (typed parts)", () => {
  const kBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

  it("keeps text parts and drops image/audio/file parts entirely", () => {
    const content = [
      { type: "text", text: "Here is the screenshot:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: kBase64 } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${kBase64}` } },
      { type: "audio", data: kBase64, format: "wav" },
      { type: "file", name: "report.pdf", data: kBase64, mimeType: "application/pdf" },
      { type: "text", text: "Thoughts?" },
    ];
    const text = normalizeHistoryContent(content);
    expect(text).toBe("Here is the screenshot:Thoughts?");
    expect(text).not.toMatch(/image|png|audio|wav|pdf|base64|iVBOR/);
  });

  it("an unknown TYPED part reads only its text-ish fields, never every value", () => {
    const text = normalizeHistoryContent([
      { type: "annotation", text: "visible note", payload: "hidden-blob", mime: "x/y" },
      { type: "widget", value: "shown", data: kBase64 },
    ]);
    expect(text).toBe("visible noteshown");
    expect(text).not.toMatch(/hidden-blob|x\/y|iVBOR/);
  });

  it("untyped unknown block shapes keep the value scraper (transcript-shape tolerance)", () => {
    expect(normalizeHistoryContent([{ weird: "still shown", nested: { deeper: "too" } }])).toBe(
      "still showntoo",
    );
    expect(normalizeHistoryContent("plain")).toBe("plain");
    expect(normalizeHistoryContent([{ type: "thinking", text: "internal" }])).toBe("");
  });
});
