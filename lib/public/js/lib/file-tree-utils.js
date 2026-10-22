import { kExpandedFoldersStorageKey } from "./storage-keys.js";

export const collectAncestorFolderPaths = (targetPath) => {
  const normalizedPath = String(targetPath || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (normalizedPath.length <= 1) return [];
  const ancestors = [];
  for (let index = 0; index < normalizedPath.length - 1; index += 1) {
    ancestors.push(normalizedPath.slice(0, index + 1).join("/"));
  }
  return ancestors;
};

export const readStoredExpandedPaths = () => {
  try {
    const rawValue = window.localStorage.getItem(kExpandedFoldersStorageKey);
    if (!rawValue) return null;
    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return null;
    return new Set(parsedValue.map((entry) => String(entry)));
  } catch {
    return null;
  }
};

export const collectFolderPaths = (node, folderPaths) => {
  if (!node || node.type !== "folder") return;
  if (node.path) folderPaths.add(node.path);
  (node.children || []).forEach((childNode) =>
    collectFolderPaths(childNode, folderPaths),
  );
};

export const collectTruncatedExpandedFolderPaths = (node, expandedPaths, folderPaths) => {
  if (!node || node.type !== "folder") return;
  if (node.truncated && expandedPaths.has(node.path || "")) {
    folderPaths.push(node.path || "");
  }
  (node.children || []).forEach((childNode) =>
    collectTruncatedExpandedFolderPaths(childNode, expandedPaths, folderPaths),
  );
};

export const collectFilePaths = (node, filePaths) => {
  if (!node) return;
  if (node.type === "file") {
    if (node.path) filePaths.push(node.path);
    return;
  }
  (node.children || []).forEach((childNode) =>
    collectFilePaths(childNode, filePaths),
  );
};

export const removeTreePath = (node, targetPath) => {
  if (!node) return null;
  const safeTargetPath = String(targetPath || "").trim();
  if (!safeTargetPath) return node;
  const nodePath = String(node.path || "").trim();
  if (nodePath === safeTargetPath) return null;
  if (node.type !== "folder") return node;
  const nextChildren = (node.children || [])
    .map((childNode) => removeTreePath(childNode, safeTargetPath))
    .filter(Boolean);
  if (nextChildren.length === (node.children || []).length) return node;
  return {
    ...node,
    children: nextChildren,
  };
};

export const replaceTreeNode = (node, nextNode) => {
  if (!node || !nextNode) return node;
  if (String(node.path || "") === String(nextNode.path || "")) return nextNode;
  if (node.type !== "folder") return node;
  const nextChildren = (node.children || []).map((childNode) =>
    replaceTreeNode(childNode, nextNode),
  );
  return {
    ...node,
    children: nextChildren,
  };
};

export const filterTreeNode = (node, normalizedQuery) => {
  if (!node) return null;
  const query = String(normalizedQuery || "")
    .trim()
    .toLowerCase();
  if (!query) return node;
  const nodeName = String(node.name || "").toLowerCase();
  const nodePath = String(node.path || "").toLowerCase();
  const isDirectMatch = nodeName.includes(query) || nodePath.includes(query);
  if (node.type === "file") {
    return isDirectMatch ? node : null;
  }
  const filteredChildren = (node.children || [])
    .map((childNode) => filterTreeNode(childNode, query))
    .filter(Boolean);
  if (!isDirectMatch && filteredChildren.length === 0) return null;
  return {
    ...node,
    children: filteredChildren,
  };
};
