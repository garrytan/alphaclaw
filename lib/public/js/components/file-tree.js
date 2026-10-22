import { h } from "preact";
import htm from "htm";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  fetchBrowseTree,
  deleteBrowseFile,
  createBrowseFile,
  createBrowseFolder,
  moveBrowsePath,
  downloadBrowseFile,
} from "../lib/api.js";
import {
  kDraftIndexChangedEventName,
  readStoredDraftPaths,
} from "../lib/browse-draft-state.js";
import {
  kLockedBrowsePaths,
  kProtectedBrowsePaths,
  matchesBrowsePolicyPath,
  normalizeBrowsePolicyPath,
} from "../lib/browse-file-policies.js";
import {
  collectAncestorFolderPaths,
  readStoredExpandedPaths,
  collectFolderPaths,
  collectTruncatedExpandedFolderPaths,
  collectFilePaths,
  removeTreePath,
  replaceTreeNode,
  filterTreeNode,
} from "../lib/file-tree-utils.js";
import { FileAddLineIcon, FolderAddLineIcon } from "./icons.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { copyTextToClipboard } from "../lib/clipboard.js";
import { kBrowseFileSavedEvent, kBrowseFileDeletedEvent, kBrowseTreeRefreshEvent } from "../lib/ui-events.js";
import { kExpandedFoldersStorageKey } from "../lib/storage-keys.js";
import { showToast } from "./toast.js";
import { useVisibleInterval } from "../hooks/use-visible-interval.js";
import { TreeContextMenu } from "./file-tree/context-menu.js";
import { CreationInput } from "./file-tree/creation-input.js";
import { TreeNode } from "./file-tree/tree-node.js";

const html = htm.bind(h);

const kTreeRefreshIntervalMs = 5000;

export const FileTree = ({
  onSelectFile = () => {},
  selectedPath = "",
  onPreviewFile = () => {},
  isActive = true,
}) => {
  const [treeRoot, setTreeRoot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedPaths, setExpandedPaths] = useState(readStoredExpandedPaths);
  const [draftPaths, setDraftPaths] = useState(readStoredDraftPaths);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActivePath, setSearchActivePath] = useState("");
  const [deleteTargetPath, setDeleteTargetPath] = useState("");
  const [deletingFile, setDeletingFile] = useState(false);
  const [creatingInFolder, setCreatingInFolder] = useState("");
  const [creatingType, setCreatingType] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [dragSourcePath, setDragSourcePath] = useState("");
  const [loadingFolderPaths, setLoadingFolderPaths] = useState(new Set());
  const [selectedFolder, setSelectedFolder] = useState("");
  const effectiveSelectedPath = selectedFolder || selectedPath;
  const searchInputRef = useRef(null);
  const treeSignatureRef = useRef("");
  // Keep expandedPaths in a ref so loadTree's identity is stable (deps []).
  // Otherwise every folder toggle returns a NEW Set → loadTree's identity
  // changes → the mount effect re-runs setLoading(true) (flashing the whole
  // tree to a spinner and losing focus/scroll) AND the interval effect tears
  // down and fires a second concurrent full-tree load (H15).
  const expandedPathsRef = useRef(expandedPaths);
  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);
  // Monotonic load counter: a later load supersedes earlier ones so overlapping
  // requests can't resolve out of order into setTreeRoot.
  const loadSeqRef = useRef(0);

  const loadTree = useCallback(async ({ showLoading = false } = {}) => {
    const loadSeq = (loadSeqRef.current += 1);
    if (showLoading) setLoading(true);
    if (showLoading) setError("");
    try {
      const data = await fetchBrowseTree();
      const nextRoot = data.root || null;
      const nextExpandedPaths =
        expandedPathsRef.current instanceof Set
          ? expandedPathsRef.current
          : new Set();
      let hydratedRoot = nextRoot;
      const hydratedPaths = new Set();
      while (true) {
        const truncatedExpandedPaths = [];
        collectTruncatedExpandedFolderPaths(
          hydratedRoot,
          nextExpandedPaths,
          truncatedExpandedPaths,
        );
        const nextFolderPath = truncatedExpandedPaths.find(
          (folderPath) => !hydratedPaths.has(folderPath),
        );
        if (!nextFolderPath) break;
        hydratedPaths.add(nextFolderPath);
        const subtreeData = await fetchBrowseTree({ path: nextFolderPath });
        if (subtreeData.root) {
          hydratedRoot = replaceTreeNode(hydratedRoot, subtreeData.root);
        }
      }
      // Drop a stale resolve: a newer load started while this one was in flight.
      if (loadSeq !== loadSeqRef.current) return;
      const nextSignature = JSON.stringify(hydratedRoot || {});
      if (treeSignatureRef.current !== nextSignature) {
        treeSignatureRef.current = nextSignature;
        setTreeRoot(hydratedRoot);
      }
      setExpandedPaths((previousPaths) =>
        previousPaths instanceof Set ? previousPaths : new Set(),
      );
      if (showLoading) setError("");
    } catch (loadError) {
      if (showLoading) {
        setError(loadError.message || "Could not load file tree");
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTree({ showLoading: true });
  }, [loadTree]);

  // Tree refresh poll (fix wave F202): shared primitive, paused while hidden —
  // no sync fs walks for a backgrounded tab.
  useVisibleInterval(() => loadTree({ showLoading: false }), kTreeRefreshIntervalMs, {
    enabled: Boolean(isActive),
  });

  useEffect(() => {
    if (!isActive) return () => {};
    const refreshTree = () => {
      loadTree({ showLoading: false });
    };
    const handleFileDeleted = (event) => {
      const deletedPath = String(event?.detail?.path || "").trim();
      if (!deletedPath) return;
      setTreeRoot((previousRoot) => removeTreePath(previousRoot, deletedPath));
    };
    refreshTree();
    window.addEventListener(kBrowseFileSavedEvent, refreshTree);
    window.addEventListener(kBrowseTreeRefreshEvent, refreshTree);
    window.addEventListener(kBrowseFileDeletedEvent, handleFileDeleted);
    return () => {
      window.removeEventListener(kBrowseFileSavedEvent, refreshTree);
      window.removeEventListener(kBrowseTreeRefreshEvent, refreshTree);
      window.removeEventListener(kBrowseFileDeletedEvent, handleFileDeleted);
    };
  }, [isActive, loadTree]);

  const normalizedSearchQuery = String(searchQuery || "")
    .trim()
    .toLowerCase();
  const rootChildren = useMemo(() => {
    const children = treeRoot?.children || [];
    if (!normalizedSearchQuery) return children;
    return children
      .map((node) => filterTreeNode(node, normalizedSearchQuery))
      .filter(Boolean);
  }, [treeRoot, normalizedSearchQuery]);
  const safeExpandedPaths =
    expandedPaths instanceof Set ? expandedPaths : new Set();
  const isSearchActive = normalizedSearchQuery.length > 0;
  const filteredFilePaths = useMemo(() => {
    const filePaths = [];
    rootChildren.forEach((node) => collectFilePaths(node, filePaths));
    return filePaths;
  }, [rootChildren]);
  const allTreeFilePaths = useMemo(() => {
    const filePaths = [];
    (treeRoot?.children || []).forEach((node) => collectFilePaths(node, filePaths));
    return new Set(filePaths);
  }, [treeRoot]);
  const folderPaths = useMemo(() => {
    const nextFolderPaths = new Set();
    rootChildren.forEach((node) => collectFolderPaths(node, nextFolderPaths));
    return nextFolderPaths;
  }, [rootChildren]);

  useEffect(() => {
    if (!(expandedPaths instanceof Set)) return;
    try {
      window.localStorage.setItem(
        kExpandedFoldersStorageKey,
        JSON.stringify(Array.from(expandedPaths)),
      );
    } catch {}
  }, [expandedPaths]);

  useEffect(() => {
    if (selectedPath) setSelectedFolder("");
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedPath) return;
    const ancestorFolderPaths = collectAncestorFolderPaths(selectedPath);
    if (!ancestorFolderPaths.length) return;
    setExpandedPaths((previousPaths) => {
      if (!(previousPaths instanceof Set)) return previousPaths;
      let didChange = false;
      const nextPaths = new Set(previousPaths);
      ancestorFolderPaths.forEach((ancestorPath) => {
        if (!nextPaths.has(ancestorPath)) {
          nextPaths.add(ancestorPath);
          didChange = true;
        }
      });
      return didChange ? nextPaths : previousPaths;
    });
  }, [selectedPath]);

  useEffect(() => {
    const handleDraftIndexChanged = (event) => {
      const eventPaths = event?.detail?.paths;
      if (Array.isArray(eventPaths)) {
        setDraftPaths(
          new Set(
            eventPaths
              .map((entry) => String(entry || "").trim())
              .filter(Boolean),
          ),
        );
        return;
      }
      setDraftPaths(readStoredDraftPaths());
    };
    window.addEventListener(
      kDraftIndexChangedEventName,
      handleDraftIndexChanged,
    );
    window.addEventListener("storage", handleDraftIndexChanged);
    return () => {
      window.removeEventListener(
        kDraftIndexChangedEventName,
        handleDraftIndexChanged,
      );
      window.removeEventListener("storage", handleDraftIndexChanged);
    };
  }, []);

  useEffect(() => {
    if (!isActive) return () => {};
    const handleGlobalSearchShortcut = (event) => {
      if (event.key !== "/") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const tagName = String(target?.tagName || "").toLowerCase();
      const isTypingTarget =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target?.isContentEditable;
      if (isTypingTarget && target !== searchInputRef.current) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleGlobalSearchShortcut);
    return () => {
      window.removeEventListener("keydown", handleGlobalSearchShortcut);
    };
  }, [isActive]);

  useEffect(() => {
    if (!isSearchActive) {
      setSearchActivePath("");
      onPreviewFile("");
      return;
    }
    if (searchActivePath && filteredFilePaths.includes(searchActivePath))
      return;
    setSearchActivePath("");
    onPreviewFile("");
  }, [isSearchActive, filteredFilePaths, searchActivePath, onPreviewFile]);

  const setFolderExpanded = async (folderPath, nextExpanded, node = null) => {
    if (nextExpanded === true && node?.truncated) {
      setLoadingFolderPaths((previousPaths) => {
        const nextPaths =
          previousPaths instanceof Set ? new Set(previousPaths) : new Set();
        nextPaths.add(folderPath);
        return nextPaths;
      });
      try {
        const data = await fetchBrowseTree({ path: folderPath });
        if (data.root) {
          setTreeRoot((previousRoot) => replaceTreeNode(previousRoot, data.root));
        }
      } catch (loadError) {
        showToast(loadError.message || "Could not load folder", "error");
        return;
      } finally {
        setLoadingFolderPaths((previousPaths) => {
          const nextPaths =
            previousPaths instanceof Set ? new Set(previousPaths) : new Set();
          nextPaths.delete(folderPath);
          return nextPaths;
        });
      }
    }
    setExpandedPaths((previousPaths) => {
      const nextPaths =
        previousPaths instanceof Set ? new Set(previousPaths) : new Set();
      if (nextExpanded === true) {
        nextPaths.add(folderPath);
        return nextPaths;
      }
      if (nextExpanded === false) {
        nextPaths.delete(folderPath);
        return nextPaths;
      }
      if (nextPaths.has(folderPath)) nextPaths.delete(folderPath);
      else nextPaths.add(folderPath);
      return nextPaths;
    });
  };

  const handleSelectFile = useCallback((filePath, options) => {
    setSelectedFolder("");
    onSelectFile(filePath, options);
  }, [onSelectFile]);

  const selectFolder = (folderPath) => {
    setSelectedFolder(folderPath);
  };

  const requestDelete = (targetPath) => {
    const normalizedTargetPath = normalizeBrowsePolicyPath(targetPath);
    if (!normalizedTargetPath) return;
    if (
      matchesBrowsePolicyPath(kLockedBrowsePaths, normalizedTargetPath) ||
      matchesBrowsePolicyPath(kProtectedBrowsePaths, normalizedTargetPath)
    ) {
      showToast("Protected or locked paths cannot be deleted", "warning");
      return;
    }
    setDeleteTargetPath(targetPath);
  };

  const deleteTargetIsFolder = folderPaths.has(deleteTargetPath);

  const confirmDelete = async () => {
    if (!deleteTargetPath || deletingFile) return;
    setDeletingFile(true);
    try {
      await deleteBrowseFile(deleteTargetPath);
      window.dispatchEvent(
        new CustomEvent(kBrowseFileSavedEvent, {
          detail: { path: deleteTargetPath },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(kBrowseFileDeletedEvent, {
          detail: { path: deleteTargetPath },
        }),
      );
      setTreeRoot((previousRoot) =>
        removeTreePath(previousRoot, deleteTargetPath),
      );
      window.dispatchEvent(new CustomEvent(kBrowseTreeRefreshEvent));
      handleSelectFile("");
      showToast(deleteTargetIsFolder ? "Folder deleted" : "File deleted", "success");
      setDeleteTargetPath("");
    } catch (deleteError) {
      showToast(deleteError.message || "Could not delete", "error");
    } finally {
      setDeletingFile(false);
    }
  };

  const getCreateFolder = (explicitFolder) => {
    if (explicitFolder !== undefined) return explicitFolder;
    if (!effectiveSelectedPath) return "";
    if (folderPaths.has(effectiveSelectedPath)) return effectiveSelectedPath;
    const lastSlash = effectiveSelectedPath.lastIndexOf("/");
    return lastSlash > 0 ? effectiveSelectedPath.slice(0, lastSlash) : "";
  };

  const requestCreate = (folderPath, type) => {
    const target = getCreateFolder(folderPath);
    if (target && matchesBrowsePolicyPath(kLockedBrowsePaths, normalizeBrowsePolicyPath(target))) {
      showToast("Cannot create inside a locked folder", "warning");
      return;
    }
    setCreatingInFolder(target);
    setCreatingType(type);
    if (target) {
      setExpandedPaths((prev) => {
        const next = prev instanceof Set ? new Set(prev) : new Set();
        next.add(target);
        return next;
      });
    }
  };

  const requestCreateFromToolbar = (type) => {
    requestCreate(getCreateFolder(), type);
  };

  const cancelCreate = () => {
    setCreatingInFolder("");
    setCreatingType("");
  };

  const confirmCreate = async (name) => {
    const folder = creatingInFolder;
    const type = creatingType;
    cancelCreate();
    const fullPath = folder ? `${folder}/${name}` : name;
    try {
      if (type === "folder") {
        await createBrowseFolder(fullPath);
        showToast("Folder created", "success");
      } else {
        await createBrowseFile(fullPath);
        showToast("File created", "success");
      }
      window.dispatchEvent(new CustomEvent(kBrowseTreeRefreshEvent));
      if (folder) {
        setExpandedPaths((prev) => {
          const next = prev instanceof Set ? new Set(prev) : new Set();
          next.add(folder);
          return next;
        });
      }
      if (type === "file") {
        handleSelectFile(fullPath);
      }
    } catch (createError) {
      showToast(createError.message || `Could not create ${type}`, "error");
    }
  };

  const openContextMenu = (menu) => {
    setContextMenu(menu);
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const requestDownload = async (targetPath) => {
    try {
      await downloadBrowseFile(targetPath);
      showToast("Download started", "success");
    } catch (downloadError) {
      showToast(downloadError.message || "Could not download file", "error");
    }
  };

  const copyPath = async (targetPath) => {
    const copied = await copyTextToClipboard(targetPath);
    if (copied) {
      showToast("Path copied", "success");
      return;
    }
    showToast("Could not copy path", "error");
  };

  const handleDragDrop = async (action, sourcePath, targetFolder) => {
    if (action === "start") {
      setDragSourcePath(sourcePath);
      return;
    }
    if (action === "end") {
      setDragSourcePath("");
      return;
    }
    if (action === "drop") {
      setDragSourcePath("");
      const basename = sourcePath.split("/").pop();
      if (!basename) return;
      const destination = targetFolder ? `${targetFolder}/${basename}` : basename;
      if (sourcePath === destination) return;
      try {
        await moveBrowsePath(sourcePath, destination);
        showToast(`Moved to ${targetFolder || "root"}`, "success");
        window.dispatchEvent(new CustomEvent(kBrowseTreeRefreshEvent));
        if (selectedPath === sourcePath) {
          handleSelectFile(destination);
        }
      } catch (moveError) {
        showToast(moveError.message || "Could not move", "error");
      }
    }
  };

  const updateSearchQuery = (nextQuery) => {
    setSearchQuery(nextQuery);
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchActivePath("");
    onPreviewFile("");
  };

  const moveSearchSelection = (direction) => {
    if (!filteredFilePaths.length) return;
    const currentIndex = filteredFilePaths.indexOf(searchActivePath);
    const delta = direction === "up" ? -1 : 1;
    const baseIndex =
      currentIndex === -1 ? (direction === "up" ? 0 : -1) : currentIndex;
    const nextIndex =
      (baseIndex + delta + filteredFilePaths.length) % filteredFilePaths.length;
    const nextPath = filteredFilePaths[nextIndex];
    setSearchActivePath(nextPath);
    onPreviewFile(nextPath);
  };

  const commitSearchSelection = () => {
    const [singlePath = ""] = filteredFilePaths;
    const targetPath =
      searchActivePath || (filteredFilePaths.length === 1 ? singlePath : "");
    if (!targetPath) return;
    handleSelectFile(targetPath);
    clearSearch();
  };

  const onSearchKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchSelection("down");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection("up");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commitSearchSelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      clearSearch();
    }
  };

  if (loading) {
    return html`
      <div class="file-tree-wrap file-tree-wrap-loading">
        <div class="file-tree-state file-tree-state-loading">
          <${LoadingSpinner} className="h-5 w-5 text-fg-muted" />
        </div>
      </div>
    `;
  }
  if (error) {
    return html`<div class="file-tree-state file-tree-state-error">
      ${error}
    </div>`;
  }
  if (!rootChildren.length && !creatingType) {
    return html`
      <div class="file-tree-wrap">
        <div class="file-tree-search">
          <input
            class="file-tree-search-input"
            type="text"
            ref=${searchInputRef}
            value=${searchQuery}
            onInput=${(event) => updateSearchQuery(event.target.value)}
            onKeyDown=${onSearchKeyDown}
            placeholder="Search files..."
            autocomplete="off"
            spellcheck=${false}
          />
          <span class="file-tree-search-actions">
            <button
              type="button"
              class="tree-folder-action"
              title="New file"
              onclick=${() => requestCreateFromToolbar("file")}
            >
              <${FileAddLineIcon} className="tree-folder-action-icon" />
            </button>
            <button
              type="button"
              class="tree-folder-action"
              title="New folder"
              onclick=${() => requestCreateFromToolbar("folder")}
            >
              <${FolderAddLineIcon} className="tree-folder-action-icon" />
            </button>
          </span>
        </div>
        <div class="file-tree-state">
          ${isSearchActive ? "No matching files." : "No files found."}
        </div>
      </div>
    `;
  }

  return html`
    <div class="file-tree-wrap">
      <div class="file-tree-search">
        <input
          class="file-tree-search-input"
          type="text"
          ref=${searchInputRef}
          value=${searchQuery}
          onInput=${(event) => updateSearchQuery(event.target.value)}
          onKeyDown=${onSearchKeyDown}
          placeholder="Search files..."
          autocomplete="off"
          spellcheck=${false}
        />
        <span class="file-tree-search-actions">
          <button
            type="button"
            class="tree-folder-action"
            title="New file"
            onclick=${() => requestCreateFromToolbar("file")}
          >
            <${FileAddLineIcon} className="tree-folder-action-icon" />
          </button>
          <button
            type="button"
            class="tree-folder-action"
            title="New folder"
            onclick=${() => requestCreateFromToolbar("folder")}
          >
            <${FolderAddLineIcon} className="tree-folder-action-icon" />
          </button>
        </span>
      </div>
      <div class="file-tree-scroll">
      <ul
        class="file-tree"
        oncontextmenu=${(e) => {
          e.preventDefault();
          openContextMenu({ x: e.clientX, y: e.clientY, targetPath: "", targetType: "root" });
        }}
        onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        onDrop=${(e) => {
          e.preventDefault();
          const sourcePath = e.dataTransfer.getData("text/plain");
          if (sourcePath) handleDragDrop("drop", sourcePath, "");
        }}
      >
        ${creatingInFolder === "" && creatingType === "folder"
          ? html`
              <${CreationInput}
                key="__root-creation__"
                type="folder"
                depth=${0}
                onConfirm=${confirmCreate}
                onCancel=${cancelCreate}
              />
            `
          : null}
        ${rootChildren.filter((n) => n.type === "folder").map(
          (node) => html`
            <${TreeNode}
              key=${node.path || node.name}
              node=${node}
              expandedPaths=${safeExpandedPaths}
              onSetFolderExpanded=${setFolderExpanded}
              onSelectFolder=${selectFolder}
              onRequestDelete=${requestDelete}
              onSelectFile=${handleSelectFile}
              onContextMenu=${openContextMenu}
              onDragDrop=${handleDragDrop}
              selectedPath=${effectiveSelectedPath}
              draftPaths=${draftPaths}
              isSearchActive=${isSearchActive}
              searchActivePath=${searchActivePath}
              creatingInFolder=${creatingInFolder}
              creatingType=${creatingType}
              onCreationConfirm=${confirmCreate}
              onCreationCancel=${cancelCreate}
              dragSourcePath=${dragSourcePath}
              loadingFolderPaths=${loadingFolderPaths}
            />
          `,
        )}
        ${creatingInFolder === "" && creatingType === "file"
          ? html`
              <${CreationInput}
                key="__root-creation__"
                type="file"
                depth=${0}
                onConfirm=${confirmCreate}
                onCancel=${cancelCreate}
              />
            `
          : null}
        ${rootChildren.filter((n) => n.type !== "folder").map(
          (node) => html`
            <${TreeNode}
              key=${node.path || node.name}
              node=${node}
              expandedPaths=${safeExpandedPaths}
              onSetFolderExpanded=${setFolderExpanded}
              onSelectFolder=${selectFolder}
              onRequestDelete=${requestDelete}
              onSelectFile=${handleSelectFile}
              onContextMenu=${openContextMenu}
              onDragDrop=${handleDragDrop}
              selectedPath=${effectiveSelectedPath}
              draftPaths=${draftPaths}
              isSearchActive=${isSearchActive}
              searchActivePath=${searchActivePath}
              creatingInFolder=${creatingInFolder}
              creatingType=${creatingType}
              onCreationConfirm=${confirmCreate}
              onCreationCancel=${cancelCreate}
              dragSourcePath=${dragSourcePath}
              loadingFolderPaths=${loadingFolderPaths}
            />
          `,
        )}
      </ul>
      </div>
      ${contextMenu
        ? html`
            <${TreeContextMenu}
              x=${contextMenu.x}
              y=${contextMenu.y}
              targetPath=${contextMenu.targetPath}
              targetType=${contextMenu.targetType}
              isLocked=${!!contextMenu.isLocked}
              onNewFile=${(folder) => requestCreate(folder, "file")}
              onNewFolder=${(folder) => requestCreate(folder, "folder")}
              onCopyPath=${copyPath}
              onDownload=${requestDownload}
              onDelete=${requestDelete}
              onClose=${closeContextMenu}
            />
          `
        : null}
      <${ConfirmDialog}
        visible=${!!deleteTargetPath}
        title=${deleteTargetIsFolder ? "Delete folder?" : "Delete file?"}
        message=${deleteTargetIsFolder
          ? `Delete folder ${deleteTargetPath || "this folder"} and all its contents?`
          : `Delete ${deleteTargetPath || "this file"}? This can be restored from diff view before sync.`}
        confirmLabel="Delete"
        confirmLoadingLabel="Deleting..."
        cancelLabel="Cancel"
        confirmTone="warning"
        confirmLoading=${deletingFile}
        confirmDisabled=${deletingFile}
        onCancel=${() => {
          if (deletingFile) return;
          setDeleteTargetPath("");
        }}
        onConfirm=${confirmDelete}
      />
    </div>
  `;
};
