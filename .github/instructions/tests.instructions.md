---
applyTo: "test/**/*.js,.vscode-test/**/*.js,package.json"
---

# Test Instructions

- Use Node's built-in `node:test` runner.
- Keep tests deterministic and network-free.
- Mock the `vscode` module instead of loading VS Code for unit tests.
- Add regression tests for URL validation, token handling boundaries, sample loading, and privacy-sensitive behavior.
- Keep smoke tests focused on extension activation and commands that work without real Jira credentials.
