---
applyTo: "extension.js,lib/**/*.js"
---

# VS Code Extension Instructions

- Treat `extension.js` as the activation, command, tree view, brief generation, and webview surface.
- Treat `lib/jiraAuth.js` as the only place for Jira authentication, OAuth callback handling, token refresh, and Jira REST request construction.
- Keep command IDs stable under the `jiraAiPm.*` namespace.
- When adding webviews, keep `enableScripts` paired with a strict CSP and nonce.
- Escape all Jira-derived text before inserting it into HTML.
- Use `vscode.window.showWarningMessage` before sending Jira-derived data to a model provider for the first time.
- Do not introduce child processes or shell execution from the extension runtime.
