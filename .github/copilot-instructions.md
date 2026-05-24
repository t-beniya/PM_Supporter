# Copilot Instructions

This repository is a VS Code extension for Jira sprint health summaries and PM/Scrum Master workflows.

## Project Shape

- Entry point: `extension.js`.
- Jira authentication and Jira REST calls live in `lib/jiraAuth.js`.
- Sample Jira data lives in `samples/jira-sprint.json`.
- Tests use Node's built-in test runner and live under `test/`.
- Dev Container uses a digest-pinned Node image in `.devcontainer/devcontainer.json`.
- CI lives in `.github/workflows/ci.yml`.

## Security Rules

- Prefer Jira OAuth 2.0 (3LO) over Jira API tokens.
- Never hard-code OAuth client secrets, Jira API tokens, model API keys, or customer data.
- Store secrets only in VS Code SecretStorage.
- Before committing or packaging, confirm that agent-facing files do not contain personal information or local absolute paths.
- Before publishing or merging security-sensitive changes, inspect Git commit history for secrets, local paths, credentials, or other evidence that could lead to a security incident.
- Keep Jira network requests HTTPS-only.
- Keep Jira API token fallback restricted to Jira Cloud `*.atlassian.net` hosts.
- Do not send reporter names, comments, changelog entries, Jira credentials, or API tokens to VS Code Language Model providers.
- Keep webview output escaped and preserve the existing CSP with a nonce.
- Do not add dependencies unless they materially reduce risk or complexity.

## Build And Validation

- Run unit tests with `npm test`.
- Run Trivy locally with `npm run trivy:install` and `npm run trivy:fs`.
- Package locally with `npx @vscode/vsce package --no-dependencies --allow-missing-repository`.
- If Node is unavailable on Windows, use the digest-pinned devcontainer image.

## Coding Style

- Use CommonJS modules.
- Keep code ASCII unless an existing file clearly needs non-ASCII content.
- Keep comments sparse and only where they clarify non-obvious behavior.
- Preserve existing VS Code API patterns and command IDs.
- Keep user-facing command titles under the `AI PM:` prefix.

## Packaging

- Use `.vscodeignore` as the VSIX packaging allow/block strategy.
- Do not re-add `package.json.files` while `.vscodeignore` exists.
- Keep generated `.vsix`, `.env*`, key files, test fixtures, devcontainer files, and CI-only scripts out of VSIX packages unless explicitly needed.
