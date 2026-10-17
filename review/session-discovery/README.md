# Saved conversation discovery review

This draft PR is a review artifact, not a change to merge into the public product. The maintained local plugin integration has not yet been published. It contains the exact changed runtime sources and workflow skill from local candidate 51c3075b3d945a82e51922a338305551a5db4086, plus the focused diff from its accepted base. Source hashes are recorded beside this file. No private conversation records, screenshots, runtime descriptors, credentials, or historic local commits are uploaded.

Review change.patch first, using source/ for complete context. The application paths in the patch are the maintained paths; the source/ prefix is only the review container.

The change adds explicit all-local-directory metadata discovery while keeping exact-directory discovery as the default. It preserves all providers, interactive sources, archive/title/cursor filters, and keeps directory clues distinct from unverified App sidebar project membership. Package version is 0.4.9. Selection still only fills an ID; existing verification and binding rules are unchanged.

Direct verification was completed against the actual local candidate, not this artifact container: TypeScript check passed; 3 existing saved-list tests passed; the plugin build passed. Real stored metadata returned 4 conversations in the selected directory with a final cursor; an existing custom-provider conversation saved elsewhere was absent there and found by the explicit all-local title query. Real cursor forwarding, the built MCP tool and a browser query were verified. Native calls were limited to thread/list with useStateDbOnly:true; no contents, task updates or bindings were read or changed. The user accepted the working demonstration before requesting external review. Private raw evidence remains local.

Please review implementation correctness and real bugs only. Do not request unrelated refactors, speculative safeguards or scope expansion. Report actionable findings with actual source file and line, or explicitly state that no blocking bug was found.
