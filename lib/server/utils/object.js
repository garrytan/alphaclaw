const isNonArrayObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

module.exports = { isNonArrayObject };
