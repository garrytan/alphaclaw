import { h } from "preact";
import htm from "htm";
import { TopicEditRow, TopicRow } from "./topic-row.js";

const html = htm.bind(h);

export const TopicTable = ({
  entries,
  agents,
  hasRegistryData,
  registryByThreadId,
  edit,
  verifyingTopicId,
  deletingTopicId,
  onEdit,
  onVerify,
  onDelete,
}) => html`
  <div class="bg-field border border-border rounded-lg overflow-hidden">
    <table class="w-full text-xs table-fixed">
      <thead>
        <tr class="border-b border-border">
          <th class="text-left px-3 py-2 text-fg-muted font-medium">Topic</th>
          <th class="text-left px-3 py-2 text-fg-muted font-medium w-36">
            Thread ID
          </th>
          ${agents.length > 0 &&
          html`
            <th class="text-left px-3 py-2 text-fg-muted font-medium w-32">
              Agent
            </th>
          `}
          ${hasRegistryData &&
          html`
            <th class="text-left px-3 py-2 text-fg-muted font-medium w-44">
              Health
            </th>
          `}
          <th class="px-3 py-2 w-28" />
        </tr>
      </thead>
      <tbody>
        ${entries.map(([id, topic]) =>
          edit.topicId === String(id)
            ? html`<${TopicEditRow}
                id=${id}
                colSpan=${3 +
                (agents.length > 0 ? 1 : 0) +
                (hasRegistryData ? 1 : 0)}
                agents=${agents}
                edit=${edit}
              />`
            : html`<${TopicRow}
                id=${id}
                topic=${topic}
                rowModel=${registryByThreadId.get(String(id))}
                agents=${agents}
                hasRegistryData=${hasRegistryData}
                verifying=${verifyingTopicId === String(id)}
                deleting=${deletingTopicId === id}
                onEdit=${onEdit}
                onVerify=${onVerify}
                onDelete=${onDelete}
              />`,
        )}
      </tbody>
    </table>
  </div>
`;
