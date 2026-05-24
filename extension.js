// @ts-check

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const {
  connectJira,
  connectJiraWithOAuth,
  connectJiraWithApiToken,
  signOutJira,
  fetchJiraIssues,
  handleOAuthCallback,
  completeOAuthWithCallbackUrl,
  normalizeBaseUrl,
  normalizeTokenBrokerUrl,
  isJiraCloudHost
} = require("./lib/jiraAuth");
const {
  redactSensitiveText,
  sanitizeText
} = require("./lib/sanitize");
const {
  buildAssigneeSummaries,
  buildAssigneeTilesHtml
} = require("./lib/assigneeTiles");
const {
  buildLocalSprintBrief,
  buildSprintBriefPrompt
} = require("./lib/sprintBrief");
const {
  formatTime,
  issueIcon,
  toAiIssueDigest,
  toIssueDigest,
  trimForTree
} = require("./lib/issueDigest");

const LEGACY_OPENAI_SECRET_KEY = "jiraAiPm.openaiApiKey";
const LANGUAGE_MODEL_DATA_SHARING_CONSENT_KEY = "jiraAiPm.languageModelDataSharingConsent";

const SAMPLE_JQL = "project = AIPM AND sprint = \"Sprint 24\" ORDER BY priority DESC, updated DESC";

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new JiraSprintProvider(context);
  migrateLegacyOpenAiSettings(context).catch((error) => {
    vscode.window.showWarningMessage(`Could not clear legacy OpenAI settings: ${toErrorMessage(error)}`);
  });

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => handleOAuthCallback(uri)
    }),
    vscode.window.registerTreeDataProvider("jiraAiPm.board", provider),
    vscode.commands.registerCommand("jiraAiPm.connectJira", () => connectJira(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.connectJiraWithOAuth", () => connectJiraWithOAuth(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.completeJiraOAuthCallback", () => completeOAuthWithCallbackUrl()),
    vscode.commands.registerCommand("jiraAiPm.connectJiraWithApiToken", () => connectJiraWithApiToken(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.signOutJira", () => signOutJira(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.configureJql", () => configureJql(provider)),
    vscode.commands.registerCommand("jiraAiPm.refreshBoard", () => refreshBoard(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.generateSprintBrief", () => generateSprintBrief(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.loadSampleData", () => loadSampleData(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.generateSampleSprintBrief", () => generateSampleSprintBrief(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.openAssigneeTiles", () => openAssigneeTiles(context, provider)),
    vscode.commands.registerCommand("jiraAiPm.configureAssistantProvider", () => configureAssistantProvider(context, provider))
  );
}

function deactivate() {}

/**
 * @param {vscode.ExtensionContext} context
 */
async function migrateLegacyOpenAiSettings(context) {
  await context.secrets.delete(LEGACY_OPENAI_SECRET_KEY);

  const config = vscode.workspace.getConfiguration("jiraAiPm");
  if (config.get("assistantProvider", "local") === "openai") {
    await config.update("assistantProvider", "local", vscode.ConfigurationTarget.Global);
  }
}

class JiraSprintProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.issues = [];
    this.lastUpdated = undefined;
    this.statusMessage = "Run AI PM: Load Sample Jira Data or Connect Jira to begin.";
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  /**
   * @param {Array<any>} issues
   * @param {string} [sourceLabel]
   */
  setIssues(issues, sourceLabel) {
    this.issues = issues;
    this.lastUpdated = new Date();
    this.statusMessage = `${issues.length} ${sourceLabel || "Jira"} issue(s) loaded.`;
    this.refresh();
  }

  /**
   * @param {string} message
   */
  setStatus(message) {
    this.statusMessage = message;
    this.refresh();
  }

  /**
   * @param {TreeNode} element
   */
  getTreeItem(element) {
    return element;
  }

  /**
   * @param {TreeNode | undefined} element
   * @returns {Thenable<TreeNode[]>}
   */
  async getChildren(element) {
    if (element) {
      return Promise.resolve(element.children || []);
    }

    const config = vscode.workspace.getConfiguration("jiraAiPm");
    const baseUrl = sanitizeText(config.get("jiraBaseUrl", ""), 120);
    const defaultJql = sanitizeText(config.get("defaultJql", ""), 160);

    const setupItems = [
      new TreeNode(
        baseUrl ? `Jira: ${baseUrl}` : "Jira: not connected",
        vscode.TreeItemCollapsibleState.None,
        baseUrl ? "pass" : "warning",
        baseUrl ? undefined : "jiraAiPm.connectJira"
      ),
      new TreeNode(
        `JQL: ${trimForTree(defaultJql || "not configured")}`,
        vscode.TreeItemCollapsibleState.None,
        "filter",
        "jiraAiPm.configureJql"
      ),
      new TreeNode(
        `AI Provider: ${assistantProviderLabel(config)}`,
        vscode.TreeItemCollapsibleState.None,
        "symbol-color",
        "jiraAiPm.configureAssistantProvider"
      )
    ];

    const actions = [
      new TreeNode("Load Sample Jira Data", vscode.TreeItemCollapsibleState.None, "beaker", "jiraAiPm.loadSampleData"),
      new TreeNode("Connect Jira", vscode.TreeItemCollapsibleState.None, "plug", "jiraAiPm.connectJira"),
      new TreeNode("Connect Jira with API Token", vscode.TreeItemCollapsibleState.None, "key", "jiraAiPm.connectJiraWithApiToken"),
      new TreeNode("Connect Jira with OAuth", vscode.TreeItemCollapsibleState.None, "key", "jiraAiPm.connectJiraWithOAuth"),
      new TreeNode("Open Assignee Tile Board", vscode.TreeItemCollapsibleState.None, "dashboard", "jiraAiPm.openAssigneeTiles"),
      new TreeNode("Configure AI Provider", vscode.TreeItemCollapsibleState.None, "settings", "jiraAiPm.configureAssistantProvider"),
      new TreeNode("Generate Sample Sprint Brief", vscode.TreeItemCollapsibleState.None, "notebook", "jiraAiPm.generateSampleSprintBrief"),
      new TreeNode("Generate Sprint Brief", vscode.TreeItemCollapsibleState.None, "notebook", "jiraAiPm.generateSprintBrief"),
      new TreeNode("Refresh Jira Board", vscode.TreeItemCollapsibleState.None, "refresh", "jiraAiPm.refreshBoard"),
      new TreeNode("Sign Out Jira", vscode.TreeItemCollapsibleState.None, "sign-out", "jiraAiPm.signOutJira")
    ];

    const issueChildren = this.issues.map((issue) => {
      const digest = toIssueDigest(issue);
      const label = `${digest.key} ${digest.summary}`;
      const node = new TreeNode(trimForTree(label, 80), vscode.TreeItemCollapsibleState.None, issueIcon(digest), undefined);
      node.description = `${digest.status} - ${digest.assignee}`;
      node.tooltip = `${digest.key}\n${digest.summary}\nStatus: ${digest.status}\nAssignee: ${digest.assignee}`;
      return node;
    });

    const issueGroup = new TreeNode(
      this.lastUpdated ? `Loaded Issues (${this.issues.length})` : "Loaded Issues",
      issueChildren.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      "issues",
      undefined,
      issueChildren
    );
    issueGroup.description = this.lastUpdated ? formatTime(this.lastUpdated) : this.statusMessage;

    return Promise.resolve([
      new TreeNode("Setup", vscode.TreeItemCollapsibleState.Expanded, "settings-gear", undefined, setupItems),
      new TreeNode("Actions", vscode.TreeItemCollapsibleState.Expanded, "play", undefined, actions),
      issueGroup
    ]);
  }
}

class TreeNode extends vscode.TreeItem {
  /**
   * @param {string} label
   * @param {vscode.TreeItemCollapsibleState} state
   * @param {string} icon
   * @param {string | undefined} command
   * @param {TreeNode[] | undefined} children
   */
  constructor(label, state, icon, command, children) {
    super(label, state);
    this.children = children;
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) {
      this.command = {
        title: label,
        command
      };
    }
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function configureAssistantProvider(context, provider) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const current = config.get("assistantProvider", "local");
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: "VS Code Language Model",
        description: "Use Copilot or another model provider installed in VS Code",
        value: "vscodeLanguageModel"
      },
      {
        label: "Local heuristic",
        description: "No network or model provider; deterministic Jira-based advice",
        value: "local"
      }
    ],
    {
      title: "Configure AI Assistant Provider",
      placeHolder: `Current: ${assistantProviderLabel(config)}`
    }
  );

  if (!selection) {
    return;
  }

  if (selection.value === "vscodeLanguageModel") {
    const consented = await ensureLanguageModelDataSharingConsent(context);
    if (!consented) {
      provider.setStatus("AI assistant provider was not changed.");
      return;
    }
  }

  await config.update("assistantProvider", selection.value, vscode.ConfigurationTarget.Global);

  if (selection.value === "vscodeLanguageModel") {
    const vendor = await vscode.window.showInputBox({
      title: "VS Code Language Model Vendor",
      prompt: "Optional vendor selector. Use copilot for GitHub Copilot, or leave blank to use any available model.",
      placeHolder: "copilot",
      value: config.get("vscodeLanguageModelVendor", "")
    });
    if (vendor === undefined) {
      return;
    }

    const family = await vscode.window.showInputBox({
      title: "VS Code Language Model Family",
      prompt: "Optional family selector. Leave blank if you want VS Code to choose from available models.",
      placeHolder: "gpt-4o",
      value: config.get("vscodeLanguageModelFamily", "")
    });
    if (family === undefined) {
      return;
    }

    const id = await vscode.window.showInputBox({
      title: "VS Code Language Model ID",
      prompt: "Optional exact model id selector. Leave blank unless you need a specific model.",
      placeHolder: "optional",
      value: config.get("vscodeLanguageModelId", "")
    });
    if (id === undefined) {
      return;
    }

    await config.update("vscodeLanguageModelVendor", vendor.trim(), vscode.ConfigurationTarget.Global);
    await config.update("vscodeLanguageModelFamily", family.trim(), vscode.ConfigurationTarget.Global);
    await config.update("vscodeLanguageModelId", id.trim(), vscode.ConfigurationTarget.Global);
  }

  provider.setStatus(`AI assistant provider set to ${selection.label}.`);
  vscode.window.showInformationMessage(`AI assistant provider set to ${selection.label}.`);
}

/**
 * @param {JiraSprintProvider} provider
 */
async function configureJql(provider) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const current = config.get("defaultJql", "");

  const jql = await vscode.window.showInputBox({
    title: "Configure Jira JQL",
    prompt: "JQL used to fetch issues for sprint briefs",
    value: current,
    placeHolder: "project = ABC AND sprint in openSprints() ORDER BY priority DESC"
  });
  if (!jql) {
    return;
  }

  await config.update("defaultJql", jql.trim(), vscode.ConfigurationTarget.Workspace);
  provider.setStatus("JQL updated.");
  vscode.window.showInformationMessage("AI PM Jira JQL updated.");
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function refreshBoard(context, provider) {
  try {
    provider.setStatus("Fetching Jira issues...");
    const issues = await fetchJiraIssues(context);
    provider.setIssues(issues);
    vscode.window.showInformationMessage(`Loaded ${issues.length} Jira issue(s).`);
  } catch (error) {
    provider.setStatus("Failed to fetch Jira issues.");
    vscode.window.showErrorMessage(`Could not refresh Jira board: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function loadSampleData(context, provider) {
  try {
    const issues = loadSampleIssues(context);
    provider.setIssues(issues, "sample Jira");
    vscode.window.showInformationMessage(`Loaded ${issues.length} sample Jira issue(s).`);
  } catch (error) {
    provider.setStatus("Failed to load sample Jira data.");
    vscode.window.showErrorMessage(`Could not load sample Jira data: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function generateSampleSprintBrief(context, provider) {
  try {
    const briefResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Generating sample sprint brief",
        cancellable: false
      },
      async () => {
        const issues = loadSampleIssues(context);
        provider.setIssues(issues, "sample Jira");
        const brief = await createSprintBrief(context, issues, {
          jql: SAMPLE_JQL,
          source: "Bundled sample Jira data"
        });
        return { issues, brief };
      }
    );

    await openMarkdownDocument(briefResult.brief);
    vscode.window.showInformationMessage(`Sample sprint brief generated from ${briefResult.issues.length} issue(s).`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not generate sample sprint brief: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function openAssigneeTiles(context, provider) {
  try {
    let issues = provider.issues;
    let source = "Loaded Jira issues";
    if (!issues.length) {
      issues = loadSampleIssues(context);
      source = "Bundled sample Jira data";
      provider.setIssues(issues, "sample Jira");
      vscode.window.showInformationMessage("No Jira issues were loaded, so sample Jira data was opened.");
    }

    const adviceResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing assignee advice",
        cancellable: false
      },
      async () => createAssistantAdvice(context, issues)
    );

    const panel = vscode.window.createWebviewPanel(
      "jiraAiPm.assigneeTiles",
      "AI PM Assignee Tiles",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    panel.webview.html = buildAssigneeTilesHtml(issues, source, adviceResult);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open assignee tile board: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Array<any>} issues
 * @returns {Promise<{ source: string, adviceByAssignee: Record<string, string> }>}
 */
async function createAssistantAdvice(context, issues) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const assistantProvider = config.get("assistantProvider", "local");

  if (assistantProvider === "vscodeLanguageModel") {
    const consented = await ensureLanguageModelDataSharingConsent(context);
    if (!consented) {
      return { source: "Local heuristic", adviceByAssignee: {} };
    }

    try {
      return await buildVsCodeLanguageModelAdvice(context, issues);
    } catch (error) {
      vscode.window.showWarningMessage(`VS Code language model advice failed; using local advice. ${toErrorMessage(error)}`);
      return { source: "Local heuristic fallback", adviceByAssignee: {} };
    }
  }

  return { source: "Local heuristic", adviceByAssignee: {} };
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Array<any>} issues
 * @returns {Promise<{ source: string, adviceByAssignee: Record<string, string> }>}
 */
async function buildVsCodeLanguageModelAdvice(context, issues) {
  if (!vscode.lm || !vscode.lm.selectChatModels || !vscode.LanguageModelChatMessage) {
    throw new Error("VS Code Language Model API is not available in this VS Code version.");
  }

  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const selector = buildLanguageModelSelector(config);
  const models = await vscode.lm.selectChatModels(selector);
  if (!models.length) {
    throw new Error("No VS Code language models matched the configured selector.");
  }

  const model = models[0];
  const cts = new vscode.CancellationTokenSource();
  const messages = [
    vscode.LanguageModelChatMessage.User(buildAssigneeAdvicePrompt(issues))
  ];

  try {
    const response = await model.sendRequest(messages, {}, cts.token);
    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
    }
    return {
      source: `VS Code LM: ${languageModelLabel(model)}`,
      adviceByAssignee: parseAdviceByAssignee(text)
    };
  } catch (error) {
    if (vscode.LanguageModelError && error instanceof vscode.LanguageModelError) {
      throw new Error(`${error.message}${error.code ? ` (${error.code})` : ""}`);
    }
    throw error;
  } finally {
    cts.dispose();
  }
}

/**
 * @param {vscode.WorkspaceConfiguration} config
 */
function buildLanguageModelSelector(config) {
  const selector = {};
  const vendor = config.get("vscodeLanguageModelVendor", "").trim();
  const family = config.get("vscodeLanguageModelFamily", "").trim();
  const id = config.get("vscodeLanguageModelId", "").trim();
  if (vendor) {
    selector.vendor = vendor;
  }
  if (family) {
    selector.family = family;
  }
  if (id) {
    selector.id = id;
  }
  return selector;
}

/**
 * @param {Array<any>} issues
 */
function buildAssigneeAdvicePrompt(issues) {
  const payload = buildAssigneeSummaries(issues).map((summary) => ({
    assignee: summary.assignee,
    total: summary.total,
    stories: summary.stories,
    tasks: summary.tasks,
    active: summary.active,
    done: summary.done,
    blocked: summary.blocked,
    overdue: summary.overdue,
    stale: summary.stale,
    focusIssues: summary.focusIssues.map((issue) => ({
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      priority: issue.priority,
      dueDate: issue.dueDate || ""
    })),
    signals: summary.signals.map((signal) => signal.text),
    localNextAction: summary.nextAction
  }));

  return [
    "Create short PM/Scrum Master advice for each assignee.",
    "Return only JSON with this exact shape: [{\"assignee\":\"name\",\"advice\":\"one or two concise sentences\"}].",
    "Do not include markdown, comments, or extra keys.",
    "Ground every recommendation in the supplied Jira summary. Do not invent details.",
    "Advice should be practical for a daily scrum or follow-up.",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseAdviceByAssignee(text) {
  const jsonText = extractJsonText(text);
  const parsed = JSON.parse(jsonText);
  const rows = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.advice) ? parsed.advice : [];
  const adviceByAssignee = {};

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const assignee = typeof row.assignee === "string" ? sanitizeText(row.assignee, 120) : "";
    const advice = typeof row.advice === "string" ? sanitizeText(row.advice, 700) : "";
    if (assignee && advice) {
      adviceByAssignee[assignee] = advice;
    }
  }

  if (!Object.keys(adviceByAssignee).length) {
    throw new Error("The model response did not include usable assignee advice.");
  }

  return adviceByAssignee;
}

/**
 * @param {string} text
 */
function extractJsonText(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  throw new Error("The model response did not contain JSON.");
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {JiraSprintProvider} provider
 */
async function generateSprintBrief(context, provider) {
  try {
    const issues = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Generating Jira sprint brief",
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: "Fetching Jira issues..." });
        const jiraIssues = await fetchJiraIssues(context);
        provider.setIssues(jiraIssues);

        progress.report({ message: "Drafting brief..." });
        const brief = await createSprintBrief(context, jiraIssues);
        return { jiraIssues, brief };
      }
    );

    await openMarkdownDocument(issues.brief);
    vscode.window.showInformationMessage(`Sprint brief generated from ${issues.jiraIssues.length} Jira issue(s).`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not generate sprint brief: ${toErrorMessage(error)}`);
  }
}

/**
 * @param {string} content
 */
async function openMarkdownDocument(content) {
  const document = await vscode.workspace.openTextDocument({
    content,
    language: "markdown"
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Array<any>}
 */
function loadSampleIssues(context) {
  const samplePath = path.normalize(path.join(context.extensionPath, "samples", "jira-sprint.json"));
  const extensionPathNormalized = path.normalize(context.extensionPath);
  if (!samplePath.startsWith(extensionPathNormalized)) {
    throw new Error("Invalid sample data path specified.");
  }
  const payload = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  if (!Array.isArray(payload.issues)) {
    throw new Error("Sample Jira payload did not include an issues array.");
  }
  if (!payload.issues.length) {
    throw new Error("Sample Jira payload did not include any issues.");
  }
  return payload.issues;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {Array<any>} issues
 * @param {{ jql?: string, source?: string }} [options]
 */
async function createSprintBrief(context, issues, options = {}) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const assistantProvider = config.get("assistantProvider", "local");
  const briefOptions = withSprintBriefDefaults(options);

  if (assistantProvider === "vscodeLanguageModel") {
    const consented = await ensureLanguageModelDataSharingConsent(context);
    if (!consented) {
      return buildLocalSprintBrief(issues, briefOptions);
    }

    try {
      return await buildVsCodeLanguageModelSprintBrief(issues, briefOptions);
    } catch (error) {
      vscode.window.showWarningMessage(`VS Code language model brief generation failed; using local fallback. ${toErrorMessage(error)}`);
      return buildLocalSprintBrief(issues, briefOptions);
    }
  }

  return buildLocalSprintBrief(issues, briefOptions);
}

/**
 * @param {{ jql?: string, source?: string }} [options]
 */
function withSprintBriefDefaults(options = {}) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  return {
    ...options,
    jql: options.jql || config.get("defaultJql", "")
  };
}

/**
 * @param {Array<any>} issues
 * @param {{ jql?: string, source?: string }} [options]
 */
async function buildVsCodeLanguageModelSprintBrief(issues, options = {}) {
  if (!vscode.lm || !vscode.lm.selectChatModels || !vscode.LanguageModelChatMessage) {
    throw new Error("VS Code Language Model API is not available in this VS Code version.");
  }

  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const selector = buildLanguageModelSelector(config);
  const models = await vscode.lm.selectChatModels(selector);
  if (!models.length) {
    throw new Error("No VS Code language models matched the configured selector.");
  }

  const model = models[0];
  const cts = new vscode.CancellationTokenSource();
  const messages = [
    vscode.LanguageModelChatMessage.User(buildSprintBriefPrompt(issues, options))
  ];

  try {
    const response = await model.sendRequest(messages, {}, cts.token);
    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
    }
    if (!text.trim()) {
      throw new Error("VS Code language model response did not include text.");
    }
    return redactSensitiveText(text.trim());
  } catch (error) {
    if (vscode.LanguageModelError && error instanceof vscode.LanguageModelError) {
      throw new Error(`${error.message}${error.code ? ` (${error.code})` : ""}`);
    }
    throw error;
  } finally {
    cts.dispose();
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function ensureLanguageModelDataSharingConsent(context) {
  if (context.globalState && context.globalState.get(LANGUAGE_MODEL_DATA_SHARING_CONSENT_KEY) === true) {
    return true;
  }

  const accepted = "Use VS Code LM";
  const choice = await vscode.window.showWarningMessage(
    "VS Code Language Model providers may receive Jira issue summaries, assignees, labels, components, versions, dates, priorities, links, parent issue text, and JQL. Reporter names, comments, changelog entries, Jira credentials, and API tokens are not sent by AI PM.",
    { modal: true },
    accepted
  );

  if (choice !== accepted) {
    return false;
  }

  if (context.globalState) {
    await context.globalState.update(LANGUAGE_MODEL_DATA_SHARING_CONSENT_KEY, true);
  }
  return true;
}

/**
 * @param {vscode.WorkspaceConfiguration} config
 */
function assistantProviderLabel(config) {
  const provider = config.get("assistantProvider", "local");
  if (provider === "vscodeLanguageModel") {
    const vendor = config.get("vscodeLanguageModelVendor", "").trim();
    const family = config.get("vscodeLanguageModelFamily", "").trim();
    const id = config.get("vscodeLanguageModelId", "").trim();
    const selector = [vendor, family, id].filter(Boolean).join(" / ");
    return selector ? `VS Code LM (${selector})` : "VS Code LM";
  }
  return "Local heuristic";
}

/**
 * @param {any} model
 */
function languageModelLabel(model) {
  return [model.vendor, model.family, model.id, model.version].filter(Boolean).join(" / ") || "selected model";
}

/**
 * @param {unknown} error
 */
function toErrorMessage(error) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

module.exports = {
  activate,
  deactivate,
  _test: {
    buildLocalSprintBrief,
    buildSprintBriefPrompt,
    loadSampleIssues,
    normalizeBaseUrl,
    normalizeTokenBrokerUrl,
    isJiraCloudHost,
    toAiIssueDigest,
    toIssueDigest
  }
};
