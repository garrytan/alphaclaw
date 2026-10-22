import { h } from "preact";
import htm from "htm";
import { useRef, useState } from "preact/hooks";
import {
  kLockedBrowsePaths,
  matchesBrowsePolicyPath,
  normalizeBrowsePolicyPath,
} from "../../lib/browse-file-policies.js";
import {
  MarkdownFillIcon,
  JavascriptFillIcon,
  File3LineIcon,
  FileMusicLineIcon,
  Image2FillIcon,
  TerminalFillIcon,
  BracesLineIcon,
  FileCodeLineIcon,
  Database2LineIcon,
  HashtagIcon,
  LockLineIcon,
} from "../icons.js";
import {
  kTreeIndentPx,
  kFolderBasePaddingPx,
  kFileBasePaddingPx,
} from "./constants.js";
import { CreationInput } from "./creation-input.js";

const html = htm.bind(h);

const getFileIconMeta = (fileName) => {
  const normalizedName = String(fileName || "").toLowerCase();
  const normalizedNameWithoutBakSuffix = normalizedName.replace(/(\.bak)+$/i, "");
  if (normalizedNameWithoutBakSuffix.endsWith(".md")) {
    return {
      icon: MarkdownFillIcon,
      className: "file-icon file-icon-md",
    };
  }
  if (
    normalizedNameWithoutBakSuffix.endsWith(".js") ||
    normalizedNameWithoutBakSuffix.endsWith(".mjs")
  ) {
    return {
      icon: JavascriptFillIcon,
      className: "file-icon file-icon-js",
    };
  }
  if (
    normalizedNameWithoutBakSuffix.endsWith(".json") ||
    normalizedNameWithoutBakSuffix.endsWith(".jsonl")
  ) {
    return {
      icon: BracesLineIcon,
      className: "file-icon file-icon-json",
    };
  }
  if (
    normalizedNameWithoutBakSuffix.endsWith(".css") ||
    normalizedNameWithoutBakSuffix.endsWith(".scss")
  ) {
    return {
      icon: HashtagIcon,
      className: "file-icon file-icon-css",
    };
  }
  if (/\.(html?)$/i.test(normalizedNameWithoutBakSuffix)) {
    return {
      icon: FileCodeLineIcon,
      className: "file-icon file-icon-html",
    };
  }
  if (
    /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(
      normalizedNameWithoutBakSuffix,
    )
  ) {
    return {
      icon: Image2FillIcon,
      className: "file-icon file-icon-image",
    };
  }
  if (
    /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i.test(
      normalizedNameWithoutBakSuffix,
    )
  ) {
    return {
      icon: FileMusicLineIcon,
      className: "file-icon file-icon-audio",
    };
  }
  if (
    /\.(sh|bash|zsh|command)$/i.test(normalizedNameWithoutBakSuffix) ||
    [
      ".bashrc",
      ".zshrc",
      ".profile",
      ".bash_profile",
      ".zprofile",
      ".zshenv",
    ].includes(normalizedNameWithoutBakSuffix)
  ) {
    return {
      icon: TerminalFillIcon,
      className: "file-icon file-icon-shell",
    };
  }
  if (
    /\.(db|sqlite|sqlite3|db3|sdb|sqlitedb|duckdb|mdb|accdb)$/i.test(
      normalizedNameWithoutBakSuffix,
    )
  ) {
    return {
      icon: Database2LineIcon,
      className: "file-icon file-icon-db",
    };
  }
  return {
    icon: File3LineIcon,
    className: "file-icon file-icon-generic",
  };
};

export const TreeNode = ({
  node,
  depth = 0,
  expandedPaths,
  onSetFolderExpanded,
  onSelectFolder,
  onRequestDelete,
  onSelectFile,
  onContextMenu,
  onDragDrop,
  selectedPath = "",
  draftPaths,
  isSearchActive = false,
  searchActivePath = "",
  creatingInFolder = "",
  creatingType = "",
  onCreationConfirm,
  onCreationCancel,
  dragSourcePath = "",
  loadingFolderPaths = new Set(),
}) => {
  if (!node) return null;
  if (node.type === "file") {
    const isActive = selectedPath === node.path;
    const isSearchActiveNode = searchActivePath === node.path;
    const hasDraft = draftPaths.has(node.path || "");
    const isLocked = matchesBrowsePolicyPath(
      kLockedBrowsePaths,
      normalizeBrowsePolicyPath(node.path || ""),
    );
    const fileIconMeta = getFileIconMeta(node.name);
    const FileTypeIcon = fileIconMeta.icon;
    return html`
      <li class="tree-item${dragSourcePath === node.path ? " is-dragging" : ""}">
        <a
          class=${`${isActive ? "active" : ""} ${isSearchActiveNode && !isActive ? "soft-active" : ""}`.trim()}
          onclick=${() => onSelectFile(node.path)}
          oncontextmenu=${(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu({ x: e.clientX, y: e.clientY, targetPath: node.path, targetType: "file", isLocked });
          }}
          draggable=${!isLocked}
          onDragStart=${(e) => {
            if (isLocked) { e.preventDefault(); return; }
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "move";
            onDragDrop("start", node.path);
          }}
          onDragEnd=${() => onDragDrop("end", "")}
          onKeyDown=${(event) => {
            const isDeleteKey =
              event.key === "Delete" || event.key === "Backspace";
            if (!isDeleteKey || !isActive) return;
            event.preventDefault();
            onRequestDelete(node.path);
          }}
          tabindex="0"
          role="button"
          style=${{
            paddingLeft: `${kFileBasePaddingPx + depth * kTreeIndentPx}px`,
          }}
          title=${node.path || node.name}
        >
          <${FileTypeIcon} className=${fileIconMeta.className} />
          <span class="tree-label">${node.name}</span>
          ${isLocked
            ? html`<${LockLineIcon}
                className="tree-lock-icon"
                title="Managed by AlphaClaw"
              />`
            : hasDraft
              ? html`<span class="tree-draft-dot" aria-hidden="true"></span>`
              : null}
        </a>
      </li>
    `;
  }

  const folderPath = node.path || "";
  const isCollapsed = isSearchActive ? false : !expandedPaths.has(folderPath);
  const isLoadingFolder = loadingFolderPaths.has(folderPath);
  const isFolderActive = selectedPath === folderPath;
  const isFolderLocked = folderPath && matchesBrowsePolicyPath(
    kLockedBrowsePaths,
    normalizeBrowsePolicyPath(folderPath),
  );
  const [isDropTarget, setIsDropTarget] = useState(false);
  const dropCounterRef = useRef(0);
  return html`
    <li class="tree-item${dragSourcePath === folderPath ? " is-dragging" : ""}">
      <div
        class=${`tree-folder ${isCollapsed ? "collapsed" : ""} ${isFolderActive ? "active" : ""} ${isDropTarget ? "is-drop-target" : ""}`.trim()}
        onclick=${() => {
          if (!folderPath) return;
          onSetFolderExpanded(folderPath, isCollapsed, node);
          onSelectFolder(folderPath);
        }}
        oncontextmenu=${(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu({ x: e.clientX, y: e.clientY, targetPath: folderPath, targetType: "folder", isLocked: isFolderLocked });
        }}
        draggable=${!!folderPath && !isFolderLocked}
        onDragStart=${(e) => {
          if (!folderPath || isFolderLocked) { e.preventDefault(); return; }
          e.dataTransfer.setData("text/plain", folderPath);
          e.dataTransfer.effectAllowed = "move";
          onDragDrop("start", folderPath);
        }}
        onDragEnd=${() => { setIsDropTarget(false); dropCounterRef.current = 0; onDragDrop("end", ""); }}
        onDragOver=${(e) => {
          if (isFolderLocked) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDragEnter=${(e) => {
          if (isFolderLocked) return;
          e.preventDefault();
          dropCounterRef.current += 1;
          if (dropCounterRef.current === 1) setIsDropTarget(true);
        }}
        onDragLeave=${() => {
          dropCounterRef.current -= 1;
          if (dropCounterRef.current <= 0) { dropCounterRef.current = 0; setIsDropTarget(false); }
        }}
        onDrop=${(e) => {
          if (isFolderLocked) return;
          e.preventDefault();
          e.stopPropagation();
          setIsDropTarget(false);
          dropCounterRef.current = 0;
          const sourcePath = e.dataTransfer.getData("text/plain");
          if (sourcePath && sourcePath !== folderPath) {
            onDragDrop("drop", sourcePath, folderPath);
          }
        }}
        style=${{
          paddingLeft: `${kFolderBasePaddingPx + depth * kTreeIndentPx}px`,
        }}
        title=${folderPath || node.name}
      >
        <button
          type="button"
          class="tree-folder-toggle"
          aria-label=${`${isCollapsed ? "Expand" : "Collapse"} ${node.name || "folder"}`}
          aria-expanded=${isCollapsed ? "false" : "true"}
          onclick=${(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!folderPath) return;
            onSetFolderExpanded(folderPath, isCollapsed, node);
          }}
          disabled=${isLoadingFolder}
        >
          <span class="arrow">▼</span>
        </button>
        <span class="tree-label">${node.name}</span>
        ${isFolderLocked
          ? html`<${LockLineIcon}
              className="tree-lock-icon"
              title="Managed by AlphaClaw"
            />`
          : null}
      </div>
      <ul class=${`tree-children ${isCollapsed ? "hidden" : ""}`}>
        ${creatingInFolder === folderPath && creatingType === "folder"
          ? html`
              <${CreationInput}
                key="__creation__"
                type="folder"
                depth=${depth + 1}
                onConfirm=${onCreationConfirm}
                onCancel=${onCreationCancel}
              />
            `
          : null}
        ${(node.children || []).filter((c) => c.type === "folder").map(
          (childNode) => html`
            <${TreeNode}
              key=${childNode.path || `${folderPath}/${childNode.name}`}
              node=${childNode}
              depth=${depth + 1}
              expandedPaths=${expandedPaths}
              onSetFolderExpanded=${onSetFolderExpanded}
              onSelectFolder=${onSelectFolder}
              onRequestDelete=${onRequestDelete}
              onSelectFile=${onSelectFile}
              onContextMenu=${onContextMenu}
              onDragDrop=${onDragDrop}
              selectedPath=${selectedPath}
              draftPaths=${draftPaths}
              isSearchActive=${isSearchActive}
              searchActivePath=${searchActivePath}
              creatingInFolder=${creatingInFolder}
              creatingType=${creatingType}
              onCreationConfirm=${onCreationConfirm}
              onCreationCancel=${onCreationCancel}
              dragSourcePath=${dragSourcePath}
              loadingFolderPaths=${loadingFolderPaths}
            />
          `,
        )}
        ${creatingInFolder === folderPath && creatingType === "file"
          ? html`
              <${CreationInput}
                key="__creation__"
                type="file"
                depth=${depth + 1}
                onConfirm=${onCreationConfirm}
                onCancel=${onCreationCancel}
              />
            `
          : null}
        ${(node.children || []).filter((c) => c.type !== "folder").map(
          (childNode) => html`
            <${TreeNode}
              key=${childNode.path || `${folderPath}/${childNode.name}`}
              node=${childNode}
              depth=${depth + 1}
              expandedPaths=${expandedPaths}
              onSetFolderExpanded=${onSetFolderExpanded}
              onSelectFolder=${onSelectFolder}
              onRequestDelete=${onRequestDelete}
              onSelectFile=${onSelectFile}
              onContextMenu=${onContextMenu}
              onDragDrop=${onDragDrop}
              selectedPath=${selectedPath}
              draftPaths=${draftPaths}
              isSearchActive=${isSearchActive}
              searchActivePath=${searchActivePath}
              creatingInFolder=${creatingInFolder}
              creatingType=${creatingType}
              onCreationConfirm=${onCreationConfirm}
              onCreationCancel=${onCreationCancel}
              dragSourcePath=${dragSourcePath}
              loadingFolderPaths=${loadingFolderPaths}
            />
          `,
        )}
      </ul>
    </li>
  `;
};
