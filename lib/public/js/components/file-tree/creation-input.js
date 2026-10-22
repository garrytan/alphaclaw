import { h } from "preact";
import htm from "htm";
import { useEffect, useRef, useState } from "preact/hooks";
import { FileAddLineIcon, FolderAddLineIcon } from "../icons.js";
import { kTreeIndentPx, kFileBasePaddingPx } from "./constants.js";

const html = htm.bind(h);

export const CreationInput = ({ type, depth, onConfirm, onCancel }) => {
  const inputRef = useRef(null);
  const [value, setValue] = useState("");
  const submittedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const name = value.trim();
    if (!name || submittedRef.current) {
      onCancel();
      return;
    }
    submittedRef.current = true;
    onConfirm(name);
  };

  const IconComponent = type === "folder" ? FolderAddLineIcon : FileAddLineIcon;
  return html`
    <li class="tree-item">
      <div
        class="tree-create-row"
        style=${{ paddingLeft: `${kFileBasePaddingPx + depth * kTreeIndentPx}px` }}
      >
        <${IconComponent} className="tree-create-icon" />
        <input
          ref=${inputRef}
          class="tree-create-input"
          type="text"
          value=${value}
          onInput=${(e) => setValue(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur=${submit}
          placeholder=${type === "folder" ? "folder name" : "file name"}
          autocomplete="off"
          spellcheck=${false}
        />
      </div>
    </li>
  `;
};
