import { fetchBrowseFilePolicies } from "./api/browse.js";

let kBrowseFilePolicies = {
  protectedPaths: [],
  lockedPaths: [],
};
try {
  const policyJson = await fetchBrowseFilePolicies();
  if (policyJson && typeof policyJson === "object") {
    kBrowseFilePolicies = policyJson;
  }
} catch {}

export const kProtectedBrowsePaths = new Set(
  Array.isArray(kBrowseFilePolicies?.protectedPaths)
    ? kBrowseFilePolicies.protectedPaths
    : [],
);

export const kLockedBrowsePaths = new Set(
  Array.isArray(kBrowseFilePolicies?.lockedPaths)
    ? kBrowseFilePolicies.lockedPaths
    : [],
);

export const normalizeBrowsePolicyPath = (inputPath) =>
  String(inputPath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();

export const matchesBrowsePolicyPath = (policyPathSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  for (const policyPath of policyPathSet) {
    if (
      safeNormalizedPath === policyPath ||
      safeNormalizedPath.endsWith(`/${policyPath}`) ||
      safeNormalizedPath.startsWith(`${policyPath}/`) ||
      safeNormalizedPath.includes(`/${policyPath}/`)
    ) {
      return true;
    }
  }
  return false;
};
