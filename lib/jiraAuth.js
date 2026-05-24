// @ts-check

const vscode = require("vscode");
const https = require("https");
const crypto = require("crypto");
const {
  redactSensitiveText,
  sanitizeText
} = require("./sanitize");

const SECRET_KEYS = {
  jiraEmail: "jiraAiPm.jiraEmail",
  jiraApiToken: "jiraAiPm.jiraApiToken",
  jiraOAuthClientSecret: "jiraAiPm.jiraOAuthClientSecret",
  jiraOAuthAccessToken: "jiraAiPm.jiraOAuthAccessToken",
  jiraOAuthRefreshToken: "jiraAiPm.jiraOAuthRefreshToken"
};

const JIRA_BASE_FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "issuetype",
  "updated",
  "created",
  "duedate",
  "labels",
  "components",
  "issuelinks",
  "parent",
  "fixVersions"
];

const JIRA_SENSITIVE_FIELDS = [
  "reporter",
  "comment"
];

const ATLASSIAN_AUTH_URL = "https://auth.atlassian.com";
const ATLASSIAN_API_URL = "https://api.atlassian.com";
const DEFAULT_OAUTH_SCOPES = "read:jira-work read:jira-user offline_access";
const OAUTH_CALLBACK_PATH = "/atlassian-oauth";
const OAUTH_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
const OAUTH_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const pendingOAuthCallbacks = new Map();

/**
 * @param {vscode.ExtensionContext} context
 * @param {any} provider
 */
async function connectJira(context, provider) {
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: "API token",
        description: "Simple local/internal setup with your Jira account email",
        command: "apiToken"
      },
      {
        label: "OAuth 2.0 (3LO)",
        description: "Use when distributing the extension or granting per-user consent",
        command: "oauth"
      }
    ],
    {
      title: "Connect Jira",
      placeHolder: "Choose the Jira authentication method"
    }
  );

  if (!selection) {
    return;
  }

  if (selection.command === "oauth") {
    await connectJiraWithOAuth(context, provider);
    return;
  }

  await connectJiraWithApiToken(context, provider);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {any} provider
 */
async function connectJiraWithApiToken(context, provider) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const existingBaseUrl = config.get("jiraBaseUrl", "");

  const baseUrlInput = await vscode.window.showInputBox({
    title: "Connect Jira",
    prompt: "Jira Cloud base URL",
    placeHolder: "https://example.atlassian.net",
    value: existingBaseUrl
  });
  if (!baseUrlInput) {
    return;
  }

  const email = await vscode.window.showInputBox({
    title: "Connect Jira",
    prompt: "Jira account email",
    placeHolder: "name@example.com"
  });
  if (!email) {
    return;
  }

  const apiToken = await vscode.window.showInputBox({
    title: "Connect Jira",
    prompt: "Jira API token",
    password: true,
    ignoreFocusOut: true
  });
  if (!apiToken) {
    return;
  }

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(baseUrlInput);
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid Jira URL: ${toErrorMessage(error)}`);
    return;
  }
  await config.update("jiraAuthMethod", "apiToken", vscode.ConfigurationTarget.Global);
  await config.update("jiraBaseUrl", baseUrl, vscode.ConfigurationTarget.Global);
  await context.secrets.store(SECRET_KEYS.jiraEmail, email.trim());
  await context.secrets.store(SECRET_KEYS.jiraApiToken, apiToken);

  try {
    const user = await jiraRequest(context, "/rest/api/3/myself", { method: "GET" });
    const name = user.displayName || user.emailAddress || "Jira";
    provider.setStatus(`Connected as ${name}.`);
    vscode.window.showInformationMessage(`AI PM connected to Jira as ${name}.`);
  } catch (error) {
    provider.setStatus("Jira credentials saved, but validation failed.");
    vscode.window.showWarningMessage(`Jira settings were saved, but validation failed: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {any} provider
 */
async function connectJiraWithOAuth(context, provider) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const existingClientId = config.get("jiraOAuthClientId", "");
  const existingRedirectUri = config.get("jiraOAuthRedirectUri", "") || defaultOAuthRedirectUri(context);
  const existingScopes = config.get("jiraOAuthScopes", "") || DEFAULT_OAUTH_SCOPES;
  const existingBrokerUrl = config.get("jiraOAuthTokenBrokerUrl", "");
  const existingSecret = await context.secrets.get(SECRET_KEYS.jiraOAuthClientSecret);

  const clientId = await vscode.window.showInputBox({
    title: "Connect Jira with OAuth",
    prompt: "Atlassian OAuth 2.0 (3LO) client ID",
    placeHolder: "From Atlassian Developer Console",
    value: existingClientId,
    ignoreFocusOut: true
  });
  if (!clientId) {
    return;
  }

  const brokerUrlInput = await vscode.window.showInputBox({
    title: "Connect Jira with OAuth",
    prompt: "Optional HTTPS token broker endpoint. Leave blank for individual or small internal use.",
    placeHolder: "https://broker.example.com/atlassian/oauth/token",
    value: existingBrokerUrl,
    ignoreFocusOut: true
  });
  if (brokerUrlInput === undefined) {
    return;
  }

  const redirectUri = await vscode.window.showInputBox({
    title: "Connect Jira with OAuth",
    prompt: "Callback URL registered in the Atlassian Developer Console",
    placeHolder: defaultOAuthRedirectUri(context),
    value: existingRedirectUri,
    ignoreFocusOut: true
  });
  if (!redirectUri) {
    return;
  }

  const scopes = await vscode.window.showInputBox({
    title: "Connect Jira with OAuth",
    prompt: "OAuth scopes configured for the Atlassian app",
    placeHolder: DEFAULT_OAUTH_SCOPES,
    value: existingScopes,
    ignoreFocusOut: true
  });
  if (!scopes) {
    return;
  }

  let brokerUrl = "";
  if (brokerUrlInput.trim()) {
    try {
      brokerUrl = normalizeTokenBrokerUrl(brokerUrlInput);
    } catch (error) {
      vscode.window.showErrorMessage(`Invalid token broker URL: ${toErrorMessage(error)}`);
      return;
    }
  }

  let clientSecret = "";
  if (!brokerUrl) {
    clientSecret = await vscode.window.showInputBox({
      title: "Connect Jira with OAuth",
      prompt: existingSecret ? "Atlassian OAuth client secret. Leave unchanged by submitting the current placeholder." : "Atlassian OAuth client secret",
      placeHolder: "Stored in VS Code SecretStorage",
      value: existingSecret ? "********" : "",
      password: true,
      ignoreFocusOut: true
    });
    if (!clientSecret) {
      return;
    }
  }

  await config.update("jiraAuthMethod", "oauth", vscode.ConfigurationTarget.Global);
  await config.update("jiraOAuthClientId", clientId.trim(), vscode.ConfigurationTarget.Global);
  await config.update("jiraOAuthRedirectUri", redirectUri.trim(), vscode.ConfigurationTarget.Global);
  await config.update("jiraOAuthScopes", scopes.trim(), vscode.ConfigurationTarget.Global);
  await config.update("jiraOAuthTokenBrokerUrl", brokerUrl, vscode.ConfigurationTarget.Global);
  if (clientSecret !== "********") {
    await context.secrets.store(SECRET_KEYS.jiraOAuthClientSecret, clientSecret);
  }
  if (brokerUrl) {
    await context.secrets.delete(SECRET_KEYS.jiraOAuthClientSecret);
  }

  try {
    provider.setStatus("Waiting for Atlassian OAuth approval...");
    const code = await requestAtlassianAuthorizationCode(context, clientId.trim(), redirectUri.trim(), scopes.trim());
    const token = await exchangeAuthorizationCodeForToken(context, code);
    await storeOAuthToken(context, token);

    const resources = await fetchAccessibleJiraResources(token.access_token);
    const resource = await pickJiraResource(resources, config.get("jiraBaseUrl", ""));
    if (!resource) {
      provider.setStatus("Jira OAuth connected, but no Jira site was selected.");
      return;
    }

    await config.update("jiraOAuthCloudId", resource.id, vscode.ConfigurationTarget.Global);
    await config.update("jiraBaseUrl", resource.url, vscode.ConfigurationTarget.Global);

    const user = await jiraRequest(context, "/rest/api/3/myself", { method: "GET" });
    const name = user.displayName || user.emailAddress || "Jira";
    provider.setStatus(`Connected to ${resource.name || resource.url} as ${name}.`);
    vscode.window.showInformationMessage(`AI PM connected to Jira with OAuth as ${name}.`);
  } catch (error) {
    provider.setStatus("Jira OAuth connection failed.");
    vscode.window.showErrorMessage(`Could not connect Jira with OAuth: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {any} provider
 */
async function signOutJira(context, provider) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  await context.secrets.delete(SECRET_KEYS.jiraOAuthAccessToken);
  await context.secrets.delete(SECRET_KEYS.jiraOAuthRefreshToken);
  await context.secrets.delete(SECRET_KEYS.jiraOAuthClientSecret);
  await context.secrets.delete(SECRET_KEYS.jiraEmail);
  await context.secrets.delete(SECRET_KEYS.jiraApiToken);
  await config.update("jiraOAuthAccessTokenExpiresAt", undefined, vscode.ConfigurationTarget.Global);
  await config.update("jiraOAuthCloudId", undefined, vscode.ConfigurationTarget.Global);
  await config.update("jiraBaseUrl", "", vscode.ConfigurationTarget.Global);
  provider.setStatus("Signed out of Jira.");
  vscode.window.showInformationMessage("AI PM signed out of Jira.");
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<Array<any>>}
 */
async function fetchJiraIssues(context) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const jql = config.get("defaultJql", "").trim();
  const maxResults = config.get("maxIssues", 50);
  const includeSensitiveFields = config.get("includeSensitiveJiraFields", false);
  const fields = includeSensitiveFields
    ? [...JIRA_BASE_FIELDS, ...JIRA_SENSITIVE_FIELDS]
    : JIRA_BASE_FIELDS;
  const searchPath = includeSensitiveFields
    ? "/rest/api/3/search?expand=changelog"
    : "/rest/api/3/search";

  if (!jql) {
    throw new Error("JQL is not configured.");
  }

  const response = await jiraRequest(context, searchPath, {
    method: "POST",
    body: {
      jql,
      maxResults,
      fields
    }
  });

  if (!Array.isArray(response.issues)) {
    throw new Error("Jira search response did not include an issues array.");
  }

  return response.issues;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} path
 * @param {{ method?: string, body?: any }} options
 */
async function jiraRequest(context, path, options) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const authMethod = config.get("jiraAuthMethod", "apiToken");

  if (authMethod === "oauth") {
    const accessToken = await getValidOAuthAccessToken(context);
    const cloudId = config.get("jiraOAuthCloudId", "");
    if (!cloudId) {
      throw new Error("Jira OAuth site is not selected. Run AI PM: Connect Jira first.");
    }

    return requestJson(`${ATLASSIAN_API_URL}/ex/jira/${encodeURIComponent(cloudId)}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      body: options.body
    });
  }

  const baseUrl = normalizeBaseUrl(config.get("jiraBaseUrl", ""));
  const email = await context.secrets.get(SECRET_KEYS.jiraEmail);
  const apiToken = await context.secrets.get(SECRET_KEYS.jiraApiToken);

  if (!baseUrl || !email || !apiToken) {
    throw new Error("Jira is not connected. Run AI PM: Connect Jira first.");
  }

  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return requestJson(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    },
    body: options.body
  });
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} clientId
 * @param {string} redirectUri
 * @param {string} scopes
 */
async function requestAtlassianAuthorizationCode(context, clientId, redirectUri, scopes) {
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = new URL(`${ATLASSIAN_AUTH_URL}/authorize`);
  authUrl.searchParams.set("audience", "api.atlassian.com");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("prompt", "consent");

  const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
  if (!opened) {
    throw new Error("Could not open the Atlassian authorization URL.");
  }

  return waitForOAuthCallbackWithManualFallback(state);
}

/**
 * @param {string} state
 * @returns {Promise<string>}
 */
function waitForOAuthCallbackWithManualFallback(state) {
  const callback = waitForOAuthCallback(state);
  promptForManualOAuthCallback(state).catch((error) => {
    const pending = pendingOAuthCallbacks.get(state);
    if (pending) {
      pending.reject(error);
    }
  });
  return callback;
}

/**
 * @param {string} state
 * @returns {Promise<void>}
 */
async function promptForManualOAuthCallback(state) {
  const action = await vscode.window.showInformationMessage(
    "Waiting for Atlassian OAuth callback. If AI PM does not continue after browser approval, run AI PM: Complete Jira OAuth Callback and paste the final vscode:// callback URL.",
    "Paste Callback URL Now"
  );

  if (action !== "Paste Callback URL Now") {
    return;
  }

  await completeOAuthWithCallbackUrl();
}

async function completeOAuthWithCallbackUrl() {
  const callbackUrl = await vscode.window.showInputBox({
    title: "Complete Jira OAuth",
    prompt: "Paste the full callback URL from the browser address bar.",
    placeHolder: "vscode://local.jira-ai-pm-editor/atlassian-oauth?code=...&state=...",
    ignoreFocusOut: true
  });
  if (!callbackUrl) {
    return;
  }

  handleOAuthCallback(vscode.Uri.parse(callbackUrl));
}

/**
 * @param {string} state
 * @returns {Promise<string>}
 */
function waitForOAuthCallback(state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (!pendingOAuthCallbacks.has(state)) {
        return;
      }

      const action = await vscode.window.showWarningMessage(
        "AI PM is still waiting for the Atlassian OAuth callback. Paste the final vscode:// callback URL to finish, or cancel this connection attempt.",
        { modal: true },
        "Paste Callback URL"
      );

      if (action === "Paste Callback URL") {
        await completeOAuthWithCallbackUrl();
        if (!pendingOAuthCallbacks.has(state)) {
          return;
        }
      }

      pendingOAuthCallbacks.delete(state);
      reject(new Error("Timed out waiting for Atlassian OAuth callback."));
    }, OAUTH_CALLBACK_TIMEOUT_MS);

    pendingOAuthCallbacks.set(state, {
      resolve: (code) => {
        clearTimeout(timer);
        resolve(code);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

/**
 * @param {vscode.Uri} uri
 */
function handleOAuthCallback(uri) {
  if (uri.path !== OAUTH_CALLBACK_PATH) {
    return;
  }

  const params = new URLSearchParams(uri.query);
  const state = params.get("state") || "";
  const pending = pendingOAuthCallbacks.get(state);
  if (!pending) {
    vscode.window.showWarningMessage("Ignored unexpected Atlassian OAuth callback.");
    return;
  }

  pendingOAuthCallbacks.delete(state);
  const error = params.get("error");
  if (error) {
    pending.reject(new Error(params.get("error_description") || error));
    return;
  }

  const code = params.get("code");
  if (!code) {
    pending.reject(new Error("Atlassian OAuth callback did not include an authorization code."));
    return;
  }

  pending.resolve(code);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} code
 */
async function exchangeAuthorizationCodeForToken(context, code) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const clientId = config.get("jiraOAuthClientId", "").trim();
  const redirectUri = (config.get("jiraOAuthRedirectUri", "") || defaultOAuthRedirectUri(context)).trim();
  const brokerUrl = normalizeTokenBrokerUrl(config.get("jiraOAuthTokenBrokerUrl", ""));
  if (brokerUrl) {
    if (!clientId || !redirectUri) {
      throw new Error("Jira OAuth client ID and redirect URI must be configured.");
    }
    return requestJson(brokerUrl, {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri
      }
    });
  }

  const clientSecret = await context.secrets.get(SECRET_KEYS.jiraOAuthClientSecret);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Jira OAuth client ID, client secret, and redirect URI must be configured.");
  }

  return requestJson(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    }
  });
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function refreshOAuthToken(context) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const clientId = config.get("jiraOAuthClientId", "").trim();
  const refreshToken = await context.secrets.get(SECRET_KEYS.jiraOAuthRefreshToken);
  const brokerUrl = normalizeTokenBrokerUrl(config.get("jiraOAuthTokenBrokerUrl", ""));
  if (brokerUrl) {
    if (!clientId || !refreshToken) {
      throw new Error("Jira OAuth refresh token is missing. Run AI PM: Connect Jira first.");
    }
    const token = await requestJson(brokerUrl, {
      method: "POST",
      body: {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken
      }
    });
    await storeOAuthToken(context, token);
    return token.access_token;
  }

  const clientSecret = await context.secrets.get(SECRET_KEYS.jiraOAuthClientSecret);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Jira OAuth refresh token is missing. Run AI PM: Connect Jira first.");
  }

  const token = await requestJson(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
    method: "POST",
    body: {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    }
  });
  await storeOAuthToken(context, token);
  return token.access_token;
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function getValidOAuthAccessToken(context) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const accessToken = await context.secrets.get(SECRET_KEYS.jiraOAuthAccessToken);
  const expiresAt = config.get("jiraOAuthAccessTokenExpiresAt", 0);
  if (accessToken && Number(expiresAt) > Date.now() + OAUTH_TOKEN_EXPIRY_SKEW_MS) {
    return accessToken;
  }
  return refreshOAuthToken(context);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {any} token
 */
async function storeOAuthToken(context, token) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  if (!token || typeof token.access_token !== "string") {
    throw new Error("Atlassian OAuth response did not include an access token.");
  }

  await context.secrets.store(SECRET_KEYS.jiraOAuthAccessToken, token.access_token);
  if (typeof token.refresh_token === "string" && token.refresh_token) {
    await context.secrets.store(SECRET_KEYS.jiraOAuthRefreshToken, token.refresh_token);
  }

  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 3600;
  await config.update("jiraOAuthAccessTokenExpiresAt", Date.now() + expiresIn * 1000, vscode.ConfigurationTarget.Global);
}

/**
 * @param {string} accessToken
 * @returns {Promise<Array<any>>}
 */
async function fetchAccessibleJiraResources(accessToken) {
  const resources = await requestJson(`${ATLASSIAN_API_URL}/oauth/token/accessible-resources`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  if (!Array.isArray(resources)) {
    throw new Error("Atlassian accessible-resources response did not include a resource list.");
  }
  return resources.filter((resource) => resource && resource.id && resource.url);
}

/**
 * @param {Array<any>} resources
 * @param {string} preferredUrl
 */
async function pickJiraResource(resources, preferredUrl) {
  if (!resources.length) {
    throw new Error("No Jira sites were available for this OAuth grant.");
  }

  const normalizedPreferredUrl = preferredUrl ? normalizeOriginLoose(preferredUrl) : "";
  const preferred = normalizedPreferredUrl
    ? resources.find((resource) => normalizeOriginLoose(resource.url) === normalizedPreferredUrl)
    : undefined;
  if (preferred) {
    return preferred;
  }

  if (resources.length === 1) {
    return resources[0];
  }

  const selection = await vscode.window.showQuickPick(
    resources.map((resource) => ({
      label: resource.name || resource.url,
      description: resource.url,
      resource
    })),
    {
      title: "Select Jira Site",
      placeHolder: "Choose the Jira site AI PM should read"
    }
  );
  return selection ? selection.resource : undefined;
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any }} options
 * @returns {Promise<any>}
 */
function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error("Network requests must use HTTPS."));
      return;
    }

    const headers = {
      ...(options.headers || {})
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    const request = https.request(parsed, {
      method: options.method || "GET",
      headers
    }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_JSON_RESPONSE_BYTES) {
          request.destroy(new Error("HTTPS response exceeded the maximum supported size."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}: ${sanitizeText(raw, 500)}`));
          return;
        }

        if (!raw) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${toErrorMessage(error)}`));
        }
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("HTTPS request timed out."));
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

/**
 * @param {string} baseUrl
 */
function normalizeBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("Enter a full HTTPS URL, for example https://example.atlassian.net.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Jira Cloud connections must use HTTPS.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Do not include credentials in the Jira URL.");
  }

  if (!isJiraCloudHost(parsed.hostname)) {
    throw new Error("Only Jira Cloud hosts under atlassian.net are supported, for example https://example.atlassian.net.");
  }

  return parsed.origin;
}

/**
 * @param {string} brokerUrl
 */
function normalizeTokenBrokerUrl(brokerUrl) {
  const value = String(brokerUrl || "").trim();
  if (!value) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a full HTTPS URL for the token broker.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Token broker connections must use HTTPS.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Do not include credentials in the token broker URL.");
  }

  parsed.hash = "";
  return parsed.toString();
}

/**
 * @param {vscode.ExtensionContext} context
 */
function defaultOAuthRedirectUri(context) {
  return `${vscode.env.uriScheme}://${context.extension.id}${OAUTH_CALLBACK_PATH}`;
}

/**
 * @param {string} value
 */
function normalizeOriginLoose(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * @param {string} hostname
 */
function isJiraCloudHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".atlassian.net");
}

/**
 * @param {unknown} error
 */
function toErrorMessage(error) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

module.exports = {
  connectJira,
  connectJiraWithOAuth,
  connectJiraWithApiToken,
  signOutJira,
  fetchJiraIssues,
  jiraRequest,
  handleOAuthCallback,
  completeOAuthWithCallbackUrl,
  normalizeBaseUrl,
  normalizeTokenBrokerUrl,
  isJiraCloudHost
};
