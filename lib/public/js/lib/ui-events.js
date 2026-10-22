// Window CustomEvent names shared across the Setup UI. Import these instead of
// writing the strings, so a typo is an import error rather than a listener
// that never fires.
export const kBrowseFileSavedEvent = "alphaclaw:browse-file-saved";
export const kBrowseFileDeletedEvent = "alphaclaw:browse-file-deleted";
export const kBrowseTreeRefreshEvent = "alphaclaw:browse-tree-refresh";
export const kBrowseGitSyncedEvent = "alphaclaw:browse-git-synced";
export const kCreateAgentEvent = "alphaclaw:create-agent";
export const kOpenWhatsappQrEvent = "alphaclaw:open-whatsapp-qr";
export const kPairingsChangedEvent = "alphaclaw:pairings-changed";
export const kAgentBindingsChangedEvent = "alphaclaw:agent-bindings-changed";
export const kRestartRequiredEvent = "alphaclaw:restart-required";
