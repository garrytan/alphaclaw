// The Google Workspace tools this plugin offers, one per tool of Google's
// remote MCP servers (/mcp/v1) that GBrain's broker accepts. Static so the
// manifest can declare every name and the relay guard can name them exactly;
// input schemas and Google's own descriptions come from the broker's `tools`
// op at run time (schemas.js), never from this file. write: the tool changes
// something in the account. summary: our one line, used until the live
// description arrives.
const kServers = Object.freeze(["gmail", "calendar", "drive", "docs", "sheets", "slides", "tasks"]);

const kEntries = [
  ["gmail", "search_threads", false, "Search the mailbox for threads."],
  ["gmail", "get_thread", false, "Read one email thread."],
  ["gmail", "get_message", false, "Read one email message."],
  ["gmail", "list_drafts", false, "List draft emails."],
  ["gmail", "get_draft", false, "Read one draft email."],
  ["gmail", "list_labels", false, "List the mailbox's labels."],
  ["gmail", "create_draft", true, "Write a draft email (never sends it)."],
  ["gmail", "create_label", true, "Create a label."],
  ["gmail", "label_thread", true, "Add labels to a thread."],
  ["gmail", "unlabel_thread", true, "Remove labels from a thread."],
  ["gmail", "label_message", true, "Add labels to a message."],
  ["gmail", "unlabel_message", true, "Remove labels from a message."],
  ["gmail", "update_message_labels", true, "Add and remove a message's labels in one step."],
  ["gmail", "apply_sensitive_thread_label", true, "Apply a sensitive label to a thread."],
  ["gmail", "apply_sensitive_message_label", true, "Apply a sensitive label to a message."],
  ["gmail", "trash_thread", true, "Move a thread to Trash."],
  ["gmail", "untrash_thread", true, "Take a thread out of Trash."],
  ["gmail", "trash_message", true, "Move a message to Trash."],
  ["gmail", "untrash_message", true, "Take a message out of Trash."],
  ["gmail", "mark_thread_spam", true, "Mark a thread as spam."],
  ["gmail", "unmark_thread_spam", true, "Unmark a thread as spam."],
  ["gmail", "mark_message_spam", true, "Mark a message as spam."],
  ["gmail", "unmark_message_spam", true, "Unmark a message as spam."],
  ["calendar", "list_calendars", false, "List the calendars."],
  ["calendar", "list_events", false, "List events on a calendar."],
  ["calendar", "search_events", false, "Search events on the primary calendar."],
  ["calendar", "get_event", false, "Read one event."],
  ["calendar", "suggest_time", false, "Suggest free times across calendars."],
  ["calendar", "create_event", true, "Create an event."],
  ["calendar", "update_event", true, "Change an event."],
  ["calendar", "delete_event", true, "Delete an event."],
  ["calendar", "respond_to_event", true, "Answer an invitation."],
  ["drive", "search_files", false, "Search Drive for files."],
  ["drive", "list_recent_files", false, "List recent Drive files."],
  ["drive", "get_file_metadata", false, "Read a file's details."],
  ["drive", "get_file_permissions", false, "List who can open a file."],
  ["drive", "read_file_content", false, "Read a file as text."],
  ["drive", "download_file_content", false, "Download a file's bytes."],
  ["drive", "copy_file", true, "Copy a file."],
  ["drive", "create_file", true, "Create or upload a file."],
  ["drive", "upload_file_revision", true, "Upload a new version of a file."],
  ["docs", "read_doc", false, "Read a document."],
  ["docs", "update_doc", true, "Edit a document."],
  ["sheets", "get_spreadsheet", false, "Read a spreadsheet's sheets and details."],
  ["sheets", "get_values", false, "Read a range of cells."],
  ["sheets", "update_values", true, "Write values to a range of cells."],
  ["sheets", "update_formulas", true, "Write formulas to a range of cells."],
  ["sheets", "insert_dimension", true, "Insert rows or columns."],
  ["sheets", "update_spreadsheet", true, "Apply spreadsheet updates."],
  ["slides", "read_presentation", false, "Read a presentation."],
  ["slides", "read_slide_page", false, "Read one slide."],
  ["slides", "read_slide_page_thumbnail", false, "Get a slide's thumbnail."],
  ["slides", "update_presentation", true, "Edit a presentation."],
  ["tasks", "list_task_lists", false, "List task lists."],
  ["tasks", "list_tasks", false, "List tasks."],
  ["tasks", "get_task", false, "Read one task."],
  ["tasks", "create_task", true, "Create a task."],
  ["tasks", "update_task", true, "Change a task."],
  ["tasks", "complete_task", true, "Mark a task complete."],
  ["tasks", "uncomplete_task", true, "Mark a task not complete."],
  ["tasks", "delete_task", true, "Delete a task."],
  ["tasks", "undelete_task", true, "Restore a deleted task."],
];

const toolNameOf = (server, tool) => "gw_" + server + "_" + tool;
const kTools = Object.freeze(kEntries.map(([server, tool, write, summary]) => Object.freeze({ name: toolNameOf(server, tool), server, tool, write, summary })));
const kByName = new Map(kTools.map((entry) => [entry.name, entry]));

// What toolSurface "core" registers directly: the day-one reads and writes.
// Everything else is reached through gw_call.
const kCoreTools = Object.freeze(
  [
    "gmail_search_threads",
    "gmail_get_thread",
    "gmail_create_draft",
    "gmail_label_thread",
    "gmail_trash_thread",
    "calendar_list_events",
    "calendar_search_events",
    "calendar_suggest_time",
    "calendar_create_event",
    "calendar_update_event",
    "drive_search_files",
    "drive_read_file_content",
    "docs_read_doc",
    "sheets_get_values",
    "sheets_update_values",
    "slides_read_presentation",
  ].map((name) => "gw_" + name),
);

const kHelperTools = Object.freeze(["gw_describe", "gw_call", "gw_check_outcome"]);
const kToolNames = Object.freeze([...kTools.map((entry) => entry.name), ...kHelperTools]);

const entryOf = (name) => kByName.get(String(name || "").trim().toLowerCase()) || null;
const entryFor = (server, tool) => entryOf(toolNameOf(String(server || "").trim().toLowerCase(), String(tool || "").trim().toLowerCase()));
const isGoogleWorkspaceTool = (name) => kToolNames.includes(String(name || "").trim().toLowerCase());

module.exports = { kServers, kTools, kCoreTools, kHelperTools, kToolNames, entryOf, entryFor, isGoogleWorkspaceTool, toolNameOf };
