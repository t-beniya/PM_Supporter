# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please do **not** open a public issue. Instead, please report it responsibly by contacting the maintainers directly.

### How to Report

1. Use GitHub's private vulnerability reporting or security advisory feature for this repository.
2. Include details about the vulnerability and its potential impact
3. Allow time for a fix before public disclosure

## Security Best Practices

- Jira API tokens are acceptable for individual or small internal use when they stay in VS Code SecretStorage.
- Prefer Jira OAuth 2.0 (3LO) when distributing the extension broadly or when per-user consent and scoped grants are required.
- For individual or small internal OAuth use, `jiraAiPm.jiraOAuthTokenBrokerUrl` may stay empty and OAuth secrets should remain in VS Code SecretStorage.
- Prefer `jiraAiPm.jiraOAuthTokenBrokerUrl` only for broad production distribution so desktop clients never handle the OAuth client secret.
- Do not hard-code OAuth client secrets or Jira API tokens in source, settings files, or VSIX packages.
- Use a trusted backend/token broker for broad distribution if an OAuth client secret must be protected from desktop clients.
- Keep dependencies up to date
- Use environment variables for sensitive data (never commit secrets)
- Follow secure coding practices
- Regular code reviews before merging

## Supported Versions

Security updates are provided for the latest version. Please keep your extension updated.
