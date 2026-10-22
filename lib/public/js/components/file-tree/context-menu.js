import { h } from "preact";
import htm from "htm";
import { useEffect, useRef } from "preact/hooks";
import {
  LockLineIcon,
  FileAddLineIcon,
  FolderAddLineIcon,
  DeleteBinLineIcon,
  DownloadLineIcon,
  FileCopyLineIcon,
} from "../icons.js";

const html = htm.bind(h);

export const TreeContextMenu = ({
  x,
  y,
  targetPath,
  targetType,
  isLocked,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onDelete,
  onClose,
}) => {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const handleScroll = () => onClose();
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const isFolder = targetType === "folder";
  const isFile = targetType === "file";
  const isRoot = targetType === "root";
  const contextFolder = isFolder ? targetPath : "";
  const canCreate = !isLocked && (isFolder || isRoot);
  const canCopyPath = Boolean((isFolder || isFile) && targetPath);
  const canDownload = isFile && targetPath;
  const canDelete = !isLocked && (isFolder || isFile) && targetPath;

  return html`
    <div
      ref=${menuRef}
      class="tree-context-menu"
      style=${{ top: `${y}px`, left: `${x}px` }}
    >
      ${canCreate
        ? html`
            <button
              class="tree-context-menu-item"
              onclick=${() => { onNewFile(contextFolder); onClose(); }}
            >
              <${FileAddLineIcon} className="tree-context-menu-icon" />
              <span>New File</span>
            </button>
            <button
              class="tree-context-menu-item"
              onclick=${() => { onNewFolder(contextFolder); onClose(); }}
            >
              <${FolderAddLineIcon} className="tree-context-menu-icon" />
              <span>New Folder</span>
            </button>
          `
        : null}
      ${canCopyPath || canDownload || canDelete
        ? html`
            ${canCreate
              ? html`<div class="tree-context-menu-sep"></div>`
              : null}
            ${canCopyPath
              ? html`
                  <button
                    class="tree-context-menu-item"
                    onclick=${() => { onCopyPath(targetPath); onClose(); }}
                  >
                    <${FileCopyLineIcon} className="tree-context-menu-icon" />
                    <span>Copy Path</span>
                  </button>
                `
              : null}
            ${canDownload
              ? html`
                  <button
                    class="tree-context-menu-item"
                    onclick=${() => { onDownload(targetPath); onClose(); }}
                  >
                    <${DownloadLineIcon} className="tree-context-menu-icon" />
                    <span>Download</span>
                  </button>
                `
              : null}
            ${canDelete
              ? html`
                  <button
                    class="tree-context-menu-item"
                    onclick=${() => { onDelete(targetPath); onClose(); }}
                  >
                    <${DeleteBinLineIcon} className="tree-context-menu-icon" />
                    <span>Delete</span>
                  </button>
                `
              : null}
          `
        : null}
      ${isLocked
        ? html`
            <div class="tree-context-menu-item is-disabled">
              <${LockLineIcon} className="tree-context-menu-icon" />
              <span>Managed by AlphaClaw</span>
            </div>
          `
        : null}
    </div>
  `;
};
