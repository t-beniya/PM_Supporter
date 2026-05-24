---
applyTo: "lib/**/*.js,extension.js,SECURITY.md,.github/workflows/*.yml,scripts/*.sh,.devcontainer/*.json"
---

# Security Instructions

- Keep OAuth and API token values out of source, logs, generated Markdown, webviews, and tests.
- Check Git commit history for committed secrets, local paths, credentials, or other evidence that could lead to a security incident before publishing or merging security-sensitive changes.
- Prefer short-lived OAuth access tokens and SecretStorage-backed refresh tokens.
- Do not broaden Jira REST fields unless the README and settings describe the privacy impact.
- Keep Trivy pinned to a reviewed version and avoid mutable `latest` references.
- Prefer digest-pinned container images for devcontainer and Docker-based verification.
- Keep CI permissions minimal. Use `contents: read` unless a job needs more.
- Do not use `curl | sh`. Download scripts or archives to a file first, then execute or install explicitly.
