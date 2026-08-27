const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getOperatorById,
  getOperatorsVersion,
  isValidOperatorId,
  listOperators,
  readOperatorsState,
  resolveOperatorsPath,
  setOperators,
} = require("../../lib/server/operators-store");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-operators-test-"));

describe("server/operators-store", () => {
  it("returns an empty roster with version 1 when the file is missing", () => {
    const openclawDir = createTempOpenclawDir();
    expect(readOperatorsState({ openclawDir })).toEqual({
      version: 1,
      operators: [],
      operatorsVersion: 1,
    });
  });

  it("persists operators with 0600 permissions", () => {
    const openclawDir = createTempOpenclawDir();
    setOperators({
      openclawDir,
      operators: [
        { id: "garry", name: "Garry", email: "g@example.com", avatar: "" },
      ],
    });
    const filePath = resolveOperatorsPath({ openclawDir });
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(listOperators({ openclawDir })).toEqual([
      { id: "garry", name: "Garry", email: "g@example.com", avatar: "" },
    ]);
  });

  it("does not bump operatorsVersion on add or edit", () => {
    const openclawDir = createTempOpenclawDir();
    setOperators({ openclawDir, operators: [{ id: "a" }] });
    expect(getOperatorsVersion({ openclawDir })).toBe(1);
    setOperators({ openclawDir, operators: [{ id: "a" }, { id: "b" }] });
    expect(getOperatorsVersion({ openclawDir })).toBe(1);
    setOperators({
      openclawDir,
      operators: [{ id: "a", name: "Renamed" }, { id: "b" }],
    });
    expect(getOperatorsVersion({ openclawDir })).toBe(1);
  });

  it("bumps operatorsVersion when an operator is removed", () => {
    const openclawDir = createTempOpenclawDir();
    setOperators({ openclawDir, operators: [{ id: "a" }, { id: "b" }] });
    setOperators({ openclawDir, operators: [{ id: "a" }] });
    expect(getOperatorsVersion({ openclawDir })).toBe(2);
    // Removing again keeps bumping.
    setOperators({ openclawDir, operators: [] });
    expect(getOperatorsVersion({ openclawDir })).toBe(3);
  });

  it("drops invalid and duplicate operators on write", () => {
    const openclawDir = createTempOpenclawDir();
    const state = setOperators({
      openclawDir,
      operators: [
        { id: "valid" },
        { id: "valid" },
        { id: "not valid with spaces" },
        { id: "" },
        null,
        "string",
      ],
    });
    expect(state.operators.map((operator) => operator.id)).toEqual(["valid"]);
  });

  it("looks up operators by id", () => {
    const openclawDir = createTempOpenclawDir();
    setOperators({ openclawDir, operators: [{ id: "garry", name: "G" }] });
    expect(getOperatorById("garry", { openclawDir })?.name).toBe("G");
    expect(getOperatorById("missing", { openclawDir })).toBeNull();
  });

  it("validates operator ids as header-safe", () => {
    expect(isValidOperatorId("garry")).toBe(true);
    expect(isValidOperatorId("g.arry_1@example-x+y")).toBe(true);
    expect(isValidOperatorId("has space")).toBe(false);
    expect(isValidOperatorId("newline\ninjection")).toBe(false);
    expect(isValidOperatorId("")).toBe(false);
    expect(isValidOperatorId(`x${"y".repeat(200)}`)).toBe(false);
  });
});
