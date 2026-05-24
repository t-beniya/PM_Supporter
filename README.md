# Jira AI PM Editor

VS Code extension prototype for Project Managers and Scrum Masters who manage work in Jira.

The first MVP can:

- Load bundled sample Jira data without a Jira API token.
- Connect to Jira Cloud with either a Jira API token or OAuth 2.0 (3LO).
- Fetch sprint issues using configurable JQL.
- Show a small Jira Sprint view in the Activity Bar.
- Open a 6-tile assignee board that shows what each person is working on and includes editable assistant advice.
- Choose the assistant provider: local rules or VS Code Language Model providers such as GitHub Copilot.
- Generate a Markdown sprint brief from Jira issue data.
- Generate AI-assisted sprint briefs and assignee advice through GitHub Copilot/VS Code Language Model providers, with a local heuristic fallback.

## Getting Started

1. Open this folder in VS Code.
2. Press `Ctrl+F5` and choose `Run Extension (No Debug)`.
3. In the Extension Development Host, run `AI PM: Load Sample Jira Data`.
4. Optional: run `AI PM: Configure AI Assistant Provider`.
5. Run `AI PM: Open Assignee Tile Board`.
6. Run `AI PM: Generate Sprint Brief from Sample Data`.

With the default local provider, this sample path does not require a Jira API token or GitHub Copilot.

The assignee board shows at most six tiles. Each tile represents one assignee and highlights active work, blocked signals, stale items, overdue work, editable AI Assistant Advice, and the next Scrum Master follow-up.

If an assignee appears to be an AI agent, for example by name or labels such as `ai-agent`, `agent`, `bot`, `copilot`, or `codex`, the tile also shows whether the agent looks like it is running, waiting for approval, failed, completed, or idle.

For GitHub Copilot or other VS Code model providers, choose `VS Code Language Model` in `AI PM: Configure AI Assistant Provider`. You can set the vendor selector to `copilot`, or leave it blank to use any available VS Code language model. VS Code may ask for consent the first time this extension uses a language model.

If `F5` appears to do nothing, use `Ctrl+F5`. In some local setups the debug Extension Host can wait for the debugger and time out before the extension activates.

## Jira Connection

Example JQL:

```jql
project = ABC AND sprint in openSprints() ORDER BY priority DESC, updated DESC
```

For a real Jira site:

1. Run `AI PM: Connect Jira`.
2. Choose `API token` for a simple local/internal setup, or `OAuth 2.0 (3LO)` if you need a distributable consent flow.
3. Run `AI PM: Configure Jira JQL`.
4. Run `AI PM: Generate Sprint Brief from Jira`.

### API Token Setup

For individual or small internal use, API token setup is the simplest path:

- Jira base URL, for example `https://example.atlassian.net`
- Atlassian account email
- Jira API token from https://id.atlassian.com/manage-profile/security/api-tokens

Jira credentials are stored in VS Code SecretStorage. Jira base URLs must use HTTPS and a Jira Cloud `atlassian.net` host.

### OAuth Setup

OAuth 2.0 (3LO) is available when you want user consent, tighter scopes, or a path toward broader distribution. AI PM stores OAuth tokens in VS Code SecretStorage and refreshes short-lived access tokens when needed.

Create an OAuth 2.0 (3LO) app in the Atlassian Developer Console:

- Add the Jira platform REST API.
- Add the minimum scopes needed by this extension: `read:jira-work read:jira-user offline_access`.
- Register the callback URL shown by `AI PM: Connect Jira with OAuth`, usually `vscode://local.jira-ai-pm-editor/atlassian-oauth` in local development.
- For individual or small internal use, leave `jiraAiPm.jiraOAuthTokenBrokerUrl` empty and copy the client ID and client secret into the connection prompts. The client secret is stored in VS Code SecretStorage on your machine.
- Token broker mode is only for broad production distribution. If `jiraAiPm.jiraOAuthTokenBrokerUrl` is set to an HTTPS endpoint, AI PM does not ask for or store the OAuth client secret.

For this small internal trial, you do not need to run a token broker. For a public Marketplace-style distribution, do not hard-code the OAuth client secret into the extension. Use a distributable Atlassian OAuth app and move token exchange to a trusted backend/token broker before shipping broadly. The broker endpoint should accept JSON token requests from AI PM:

```json
{
  "grant_type": "authorization_code",
  "client_id": "public-client-id",
  "code": "authorization-code",
  "redirect_uri": "vscode://publisher.extension/atlassian-oauth"
}
```

and refresh requests:

```json
{
  "grant_type": "refresh_token",
  "client_id": "public-client-id",
  "refresh_token": "refresh-token"
}
```

The broker should add the protected OAuth client secret server-side, call Atlassian's token endpoint, and return the Atlassian token JSON to the extension.

If OAuth times out after browser approval, the callback likely opened a different VS Code window or was blocked by the OS protocol prompt. Run `AI PM: Connect Jira with OAuth` again, then run `AI PM: Complete Jira OAuth Callback` while the connection attempt is still waiting. Paste the full `vscode://.../atlassian-oauth?code=...&state=...` URL from the browser address bar.

## Assistant Provider Setup

Run `AI PM: Configure AI Assistant Provider` to choose how sprint briefs and assignee tile advice are generated.

- `Local heuristic`: no external model provider; deterministic Jira-based output.
- `VS Code Language Model`: uses GitHub Copilot or another language model provider installed in VS Code. The extension does not store a model API key.

For GitHub Copilot, choose `VS Code Language Model`. Set the vendor selector to `copilot` if you want to require Copilot, or leave the selector fields blank to let VS Code choose any available model.

Without a model provider, the extension still generates a deterministic local brief from Jira statuses, assignees, due dates, and labels. Reporter names, comments, and changelog data are not fetched by default; enable `jiraAiPm.includeSensitiveJiraFields` only when you need those richer local-only signals.

When using VS Code Language Model providers, Jira issue summaries, assignees, labels, components, versions, dates, priorities, links, parent issue text, and JQL may be sent to the selected model provider. AI PM asks for confirmation before first use. Reporter names, comments, changelog entries, Jira credentials, and API tokens are kept out of model prompts by default.

## Developer Checks

Run the unit tests:

```bash
npm test
```

Install and run pre-commit hooks:

```bash
npm run precommit:install
npm run precommit
```

Run the Trivy filesystem scan:

```bash
npm run cosign:install
npm run trivy:install
npm run trivy:fs
```

The extension does not manage OpenAI or other model provider API keys.
