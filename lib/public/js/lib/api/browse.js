import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const fetchBrowseTree = async (options = {}) => {
  const { depth = 3, path = "" } =
    typeof options === "number" ? { depth: options, path: "" } : options;
  const params = new URLSearchParams({ depth: String(depth) });
  if (path) params.set("path", String(path));
  const res = await authFetch(`/api/browse/tree?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file tree");
};

export const fetchFileContent = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/read?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file content");
};

export const saveFileContent = async (filePath, content) => {
  const normalizedPath = String(filePath || "");
  const normalizedContent = typeof content === "string" ? content : String(content ?? "");
  const res = await authFetch("/api/browse/write", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: normalizedPath, content: normalizedContent }),
  });
  return parseJsonOrThrow(res, "Could not save file");
};

export const createBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/create-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not create file");
};

export const createBrowseFolder = async (folderPath) => {
  const res = await authFetch("/api/browse/create-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(folderPath || "") }),
  });
  return parseJsonOrThrow(res, "Could not create folder");
};

export const moveBrowsePath = async (from, to) => {
  const res = await authFetch("/api/browse/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: String(from || ""), to: String(to || "") }),
  });
  return parseJsonOrThrow(res, "Could not move path");
};

export const deleteBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not delete file");
};

export const downloadBrowseFile = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/download?${params.toString()}`, { rawResponse: true });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || "Could not download file");
  }
  const fileBlob = await res.blob();
  const urlApi = window?.URL || URL;
  if (!urlApi?.createObjectURL || !urlApi?.revokeObjectURL) {
    throw new Error("Download is not supported in this browser");
  }
  const downloadUrl = urlApi.createObjectURL(fileBlob);
  const fileName =
    String(filePath || "")
      .split("/")
      .filter(Boolean)
      .pop() || "download";
  try {
    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.download = fileName;
    document.body?.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  } finally {
    urlApi.revokeObjectURL(downloadUrl);
  }
  return { ok: true };
};

export const restoreBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not restore file");
};

export const fetchBrowseGitSummary = async () => {
  const res = await authFetch("/api/browse/git-summary");
  return parseJsonOrThrow(res, "Could not load git summary");
};

export const fetchBrowseFileDiff = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/git-diff?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file diff");
};

export const fetchBrowseSqliteTable = async ({
  filePath,
  table,
  limit = 50,
  offset = 0,
}) => {
  const params = new URLSearchParams({
    path: String(filePath || ""),
    table: String(table || ""),
    limit: String(limit),
    offset: String(offset),
  });
  const res = await authFetch(`/api/browse/sqlite-table?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load sqlite table data");
};

export const syncBrowseChanges = async (message = "") => {
  const res = await authFetch("/api/browse/git-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(message || "") }),
  });
  return parseJsonOrThrow(res, "Could not sync changes");
};
