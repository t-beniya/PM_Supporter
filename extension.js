// @ts-check

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
    const baseUrl = config.get("jiraBaseUrl", "");
    const defaultJql = config.get("defaultJql", "");

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
    const assignee = typeof row.assignee === "string" ? row.assignee.trim() : "";
    const advice = typeof row.advice === "string" ? row.advice.trim() : "";
    if (assignee && advice) {
      adviceByAssignee[assignee] = trimText(advice, 700);
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
  const samplePath = path.join(context.extensionPath, "samples", "jira-sprint.json");
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

  if (assistantProvider === "vscodeLanguageModel") {
    const consented = await ensureLanguageModelDataSharingConsent(context);
    if (!consented) {
      return buildLocalSprintBrief(issues, options);
    }

    try {
      return await buildVsCodeLanguageModelSprintBrief(issues, options);
    } catch (error) {
      vscode.window.showWarningMessage(`VS Code language model brief generation failed; using local fallback. ${toErrorMessage(error)}`);
      return buildLocalSprintBrief(issues, options);
    }
  }

  return buildLocalSprintBrief(issues, options);
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
    return text.trim();
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
 * @param {Array<any>} issues
 * @param {{ jql?: string, source?: string }} [options]
 */
function buildSprintBriefPrompt(issues, options = {}) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const jql = options.jql || config.get("defaultJql", "");
  const issueDigests = issues.map(toAiIssueDigest);
  return [
    "You are an expert Project Manager and Scrum Master.",
    "Write concise Japanese Markdown for a daily sprint brief.",
    "Focus on current status, risks, blockers, follow-up questions, and concrete next actions.",
    "Do not invent issue details that are not present in the supplied Jira data.",
    "Use these sections: Summary, Status Breakdown, Risks, Blockers, Daily Scrum Questions, Next Actions, Issue Snapshot.",
    "",
    ...(options.source ? [`Source: ${options.source}`, ""] : []),
    `JQL: ${jql}`,
    "",
    "Jira issues:",
    JSON.stringify(issueDigests, null, 2)
  ].join("\n");
}

/**
 * @param {Array<any>} issues
 * @param {{ jql?: string, source?: string }} [options]
 */
function buildLocalSprintBrief(issues, options = {}) {
  const config = vscode.workspace.getConfiguration("jiraAiPm");
  const jql = options.jql || config.get("defaultJql", "");
  const digests = issues.map(toIssueDigest);
  const total = digests.length;
  const done = digests.filter((issue) => issue.isDone).length;
  const active = digests.filter((issue) => !issue.isDone).length;
  const unassigned = digests.filter((issue) => issue.assignee === "Unassigned");
  const blocked = digests.filter(isBlockedDigest);
  const stale = digests.filter((issue) => !issue.isDone && issue.daysSinceUpdated >= 3);
  const overdue = digests.filter((issue) => !issue.isDone && issue.dueDate && isPastDate(issue.dueDate));
  const review = digests.filter((issue) => /review|qa|test|verify|validation/i.test(issue.status));
  const highPriority = digests.filter((issue) => !issue.isDone && /highest|high|critical|blocker|urgent/i.test(issue.priority));

  const lines = [
    "# Sprint Brief",
    "",
    `Generated: ${new Date().toLocaleString()}`,
    ...(options.source ? [`Source: ${options.source}`] : []),
    "",
    `JQL: \`${jql}\``,
    "",
    "## Summary",
    "",
    `- Total issues: ${total}`,
    `- Done: ${done}`,
    `- Active: ${active}`,
    `- Blocker candidates: ${blocked.length}`,
    `- Stale active issues (3+ days without update): ${stale.length}`,
    "",
    "## Status Breakdown",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    ...mapCounts(digests, "status").map(([status, count]) => `| ${escapeTable(status)} | ${count} |`),
    "",
    "## Risks",
    "",
    ...riskLines("Overdue", overdue),
    ...riskLines("High priority still open", highPriority),
    ...riskLines("Unassigned", unassigned),
    ...riskLines("Stale", stale),
    ...(overdue.length || highPriority.length || unassigned.length || stale.length ? [] : ["- No obvious risk candidates found from the current Jira fields."]),
    "",
    "## Blockers",
    "",
    ...riskLines("Blocked candidate", blocked),
    ...(blocked.length ? [] : ["- No explicit blocker candidates found in the fetched Jira fields."]),
    "",
    "## Daily Scrum Questions",
    "",
    ...questionLines(blocked, stale, review, unassigned),
    "",
    "## Next Actions",
    "",
    ...nextActionLines(blocked, overdue, stale, review, unassigned),
    "",
    "## Issue Snapshot",
    "",
    "| Key | Type | Status | Assignee | Priority | Updated | Summary |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...digests.map((issue) => [
      issue.key,
      escapeTable(issue.type),
      escapeTable(issue.status),
      escapeTable(issue.assignee),
      escapeTable(issue.priority),
      escapeTable(issue.updatedDate),
      escapeTable(issue.summary)
    ].join(" | ")).map((row) => `| ${row} |`)
  ];

  return lines.join("\n");
}

/**
 * @param {Array<any>} issues
 * @param {string} source
 * @param {{ source: string, adviceByAssignee: Record<string, string> }} adviceResult
 */
function buildAssigneeTilesHtml(issues, source, adviceResult = { source: "Local heuristic", adviceByAssignee: {} }) {
  const assignees = buildAssigneeSummaries(issues, adviceResult.adviceByAssignee);
  const visibleAssignees = assignees.slice(0, 6);
  const pageCount = Math.max(1, Math.ceil(assignees.length / 6));
  const totalIssues = issues.length;
  const digests = issues.map(toIssueDigest);
  const activeIssues = digests.filter((issue) => !issue.isDone).length;
  const sprintTiming = buildSprintTimingSummary(issues, digests);
  const generatedAt = new Date().toLocaleString();
  const nonce = getNonce();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI PM Assignee Tiles</title>
  <style>
    :root {
      color-scheme: light dark;
      --tile-border: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
      --tile-muted: var(--vscode-descriptionForeground);
      --tile-bg: var(--vscode-editor-background);
      --tile-soft: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, var(--vscode-editor-background));
      --risk: #d13f3f;
      --watch: #c27a12;
      --ok: #2f9d58;
      --info: #4a83d8;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }

    main {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 20px;
    }

    .topbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--tile-border);
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: 0;
    }

    .meta {
      color: var(--tile-muted);
      font-size: 12px;
      text-align: right;
      overflow-wrap: anywhere;
    }

    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin: 14px 0 18px;
      color: var(--tile-muted);
      font-size: 12px;
    }

    .sprint-summary {
      flex-basis: 100%;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      min-width: 0;
      padding: 10px 12px;
      border: 1px solid var(--tile-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--tile-soft);
    }

    .sprint-days {
      display: grid;
      gap: 3px;
      font-size: 24px;
      font-weight: 750;
      line-height: 1;
      white-space: nowrap;
    }

    .sprint-days-label {
      color: var(--tile-muted);
      font-size: 11px;
      font-weight: 650;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .sprint-text {
      min-width: 0;
      color: var(--tile-muted);
      overflow-wrap: anywhere;
    }

    .pager {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }

    .nav-button {
      min-width: 64px;
      border: 1px solid var(--tile-border);
      border-radius: 6px;
      padding: 5px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      cursor: pointer;
    }

    .nav-button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .nav-button:disabled {
      cursor: default;
      opacity: 0.45;
    }

    .page-label {
      min-width: 78px;
      color: var(--tile-muted);
      font-size: 12px;
      text-align: center;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }

    .tile {
      min-height: 430px;
      border: 1px solid var(--tile-border);
      border-radius: 8px;
      background: var(--tile-soft);
      padding: 14px;
      display: grid;
      grid-template-rows: auto auto auto auto 1fr auto;
      gap: 12px;
      overflow: hidden;
    }

    .tile-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }

    .name {
      min-width: 0;
      font-size: 18px;
      font-weight: 650;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .tone {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-top: 5px;
      background: var(--ok);
    }

    .tone.risk {
      background: var(--risk);
    }

    .tone.watch {
      background: var(--watch);
    }

    .tone.info {
      background: var(--info);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .metric {
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--tile-border);
      border-radius: 6px;
      background: var(--tile-bg);
    }

    .metric-value {
      display: block;
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
    }

    .metric-label {
      display: block;
      margin-top: 4px;
      color: var(--tile-muted);
      font-size: 11px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .section-title {
      margin: 0 0 6px;
      color: var(--tile-muted);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .focus {
      min-height: 76px;
    }

    .issue-list {
      display: grid;
      gap: 7px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .issue {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: baseline;
      min-width: 0;
    }

    .issue-key {
      color: var(--vscode-textLink-foreground);
      font-weight: 650;
      white-space: nowrap;
    }

    .issue-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .signals {
      display: grid;
      gap: 6px;
      color: var(--tile-muted);
      font-size: 12px;
    }

    .signal {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 7px;
      align-items: baseline;
    }

    .signal-mark {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--info);
    }

    .signal-mark.risk {
      background: var(--risk);
    }

    .signal-mark.watch {
      background: var(--watch);
    }

    .signal-mark.ok {
      background: var(--ok);
    }

    .agent-strip {
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid var(--tile-border);
      border-radius: 6px;
      background: var(--tile-bg);
    }

    .agent-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .agent-label {
      min-width: 0;
      font-size: 11px;
      font-weight: 650;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    .agent-badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 11px;
      font-weight: 650;
      line-height: 1.3;
    }

    .agent-badge.risk {
      background: var(--risk);
    }

    .agent-badge.watch {
      background: var(--watch);
    }

    .agent-badge.info {
      background: var(--info);
    }

    .agent-badge.ok {
      background: var(--ok);
    }

    .agent-text {
      color: var(--tile-muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .next {
      border-top: 1px solid var(--tile-border);
      padding-top: 10px;
      color: var(--tile-muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .assistant-advice {
      min-width: 0;
    }

    .advice-input {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      border: 1px solid var(--tile-border);
      border-radius: 6px;
      padding: 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      line-height: 1.4;
    }

    .advice-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    @media (min-width: 1160px) {
      .grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }

    @media (max-width: 760px) {
      main {
        padding: 12px;
      }

      .topbar {
        grid-template-columns: 1fr;
      }

      .meta {
        text-align: left;
      }

      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .sprint-summary {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div>
        <h1>Assignee Tile Board</h1>
      </div>
      <div class="meta">${escapeHtml(source)}<br>Advice: ${escapeHtml(adviceResult.source)}<br>${escapeHtml(generatedAt)}</div>
    </header>

    <div class="summary">
      <div class="sprint-summary">
        <div class="sprint-days"><span class="sprint-days-label">Remaining days</span>${escapeHtml(sprintTiming.remainingText)}</div>
        <div class="sprint-text">${escapeHtml(sprintTiming.description)}</div>
      </div>
      <span>${totalIssues} issues</span>
      <span>${activeIssues} active</span>
      <span>${assignees.length} assignees</span>
      <span>Max 6 tiles per page</span>
      <div class="pager" ${pageCount <= 1 ? "hidden" : ""}>
        <button id="prevPage" class="nav-button" type="button">Prev</button>
        <span id="pageLabel" class="page-label">Page 1 / ${pageCount}</span>
        <button id="nextPage" class="nav-button" type="button">Next</button>
      </div>
    </div>

    <section id="assigneeGrid" class="grid" aria-label="Assignee tiles">
      ${visibleAssignees.map(renderAssigneeTile).join("\n")}
    </section>
  </main>
  <script nonce="${nonce}">
    const assigneePages = ${safeJsonForScript(assignees)};
    const pageSize = 6;
    let currentPage = 0;
    const vscodeApi = acquireVsCodeApi();
    const savedState = vscodeApi.getState() || {};
    const adviceByAssignee = { ...(savedState.adviceByAssignee || {}) };
    const grid = document.getElementById("assigneeGrid");
    const prevButton = document.getElementById("prevPage");
    const nextButton = document.getElementById("nextPage");
    const pageLabel = document.getElementById("pageLabel");

    function html(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function metric(value, label) {
      return '<div class="metric"><span class="metric-value">' + value + '</span><span class="metric-label">' + html(label) + '</span></div>';
    }

    function focusIssues(issues) {
      if (!issues.length) {
        return '<div class="signals"><div class="signal"><span class="signal-mark info"></span><span>No active issue assigned.</span></div></div>';
      }
      return '<ul class="issue-list">' + issues.map((issue) => '<li class="issue"><span class="issue-key">' + html(issue.key) + '</span><span class="issue-text">' + html(issue.summary) + '</span></li>').join("") + '</ul>';
    }

    function agentStrip(summary) {
      if (!summary.agentStatus || !summary.agentStatus.isAgent) {
        return "";
      }
      const status = summary.agentStatus;
      return '<section class="agent-strip">' +
        '<div class="agent-heading"><span class="agent-label">AI Agent</span><span class="agent-badge ' + html(status.tone) + '">' + html(status.label) + '</span></div>' +
        '<div class="agent-text">' + html(status.text) + '</div>' +
        '</section>';
    }

    function advice(summary) {
      const value = adviceByAssignee[summary.assignee] ?? summary.assistantAdvice ?? "";
      return '<section class="assistant-advice">' +
        '<h2 class="section-title">AI Assistant Advice</h2>' +
        '<textarea class="advice-input" data-assignee="' + html(summary.assignee) + '" spellcheck="false">' + html(value) + '</textarea>' +
        '</section>';
    }

    function tile(summary) {
      return '<article class="tile">' +
        '<div class="tile-header"><div class="name">' + html(summary.assignee) + '</div><span class="tone ' + html(summary.tone) + '" aria-hidden="true"></span></div>' +
        '<div class="metrics">' + metric(summary.stories, "Stories") + metric(summary.tasks, "Tasks") + metric(summary.active, "Active") + metric(summary.blocked, "Blocked") + metric(summary.done, "Done") + metric(summary.total, "Total") + '</div>' +
        agentStrip(summary) +
        '<section class="focus"><h2 class="section-title">Current Focus</h2>' + focusIssues(summary.focusIssues) + '</section>' +
        '<section><h2 class="section-title">Signals</h2><div class="signals">' +
        summary.signals.map((signal) => '<div class="signal"><span class="signal-mark ' + html(signal.tone) + '"></span><span>' + html(signal.text) + '</span></div>').join("") +
        '</div></section>' +
        advice(summary) +
        '<div class="next">' + html(summary.nextAction) + '</div>' +
      '</article>';
    }

    function renderPage() {
      const pageCount = Math.max(1, Math.ceil(assigneePages.length / pageSize));
      currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
      const start = currentPage * pageSize;
      grid.innerHTML = assigneePages.slice(start, start + pageSize).map(tile).join("");
      if (pageLabel) {
        pageLabel.textContent = "Page " + (currentPage + 1) + " / " + pageCount;
      }
      if (prevButton) {
        prevButton.disabled = currentPage === 0;
      }
      if (nextButton) {
        nextButton.disabled = currentPage >= pageCount - 1;
      }
    }

    grid.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) {
        return;
      }
      const assignee = target.dataset.assignee;
      if (!assignee) {
        return;
      }
      adviceByAssignee[assignee] = target.value;
      const summary = assigneePages.find((item) => item.assignee === assignee);
      if (summary) {
        summary.assistantAdvice = target.value;
      }
      vscodeApi.setState({ adviceByAssignee });
    });

    prevButton?.addEventListener("click", () => {
      currentPage -= 1;
      renderPage();
    });

    nextButton?.addEventListener("click", () => {
      currentPage += 1;
      renderPage();
    });

    renderPage();
  </script>
</body>
</html>`;
}

/**
 * @param {Array<any>} issues
 * @param {Record<string, string>} [adviceByAssignee]
 */
function buildAssigneeSummaries(issues, adviceByAssignee = {}) {
  const groups = new Map();
  for (const issue of issues.map(toIssueDigest)) {
    const key = issue.assignee || "Unassigned";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(issue);
  }

  return Array.from(groups.entries()).map(([assignee, assigneeIssues]) => {
    const active = assigneeIssues.filter((issue) => !issue.isDone);
    const done = assigneeIssues.filter((issue) => issue.isDone);
    const stories = assigneeIssues.filter((issue) => isStoryIssueType(issue.type));
    const tasks = assigneeIssues.filter((issue) => isTaskIssueType(issue.type));
    const blocked = assigneeIssues.filter(isBlockedDigest);
    const overdue = active.filter((issue) => issue.dueDate && isPastDate(issue.dueDate));
    const stale = active.filter((issue) => issue.daysSinceUpdated >= 3);
    const review = active.filter((issue) => /review|qa|test/i.test(issue.status));
    const highPriority = active.filter((issue) => /highest|high|critical|blocker/i.test(issue.priority));
    const focusIssues = active
      .slice()
      .sort(compareIssuesForFocus)
      .slice(0, 3);
    const agentStatus = buildAgentStatus(assignee, assigneeIssues, active, done);

    const signals = [];
    if (agentStatus.isAgent) {
      signals.push({ tone: agentStatus.tone, text: agentStatus.signal });
    }
    if (blocked.length) {
      signals.push({ tone: "risk", text: `${blocked.length} blocked or waiting signal${blocked.length === 1 ? "" : "s"}` });
    }
    if (overdue.length) {
      signals.push({ tone: "risk", text: `${overdue.length} overdue active issue${overdue.length === 1 ? "" : "s"}` });
    }
    if (stale.length) {
      signals.push({ tone: "watch", text: `${stale.length} active issue${stale.length === 1 ? "" : "s"} stale for 3+ days` });
    }
    if (review.length) {
      signals.push({ tone: "info", text: `${review.length} review or QA item${review.length === 1 ? "" : "s"}` });
    }
    if (highPriority.length) {
      signals.push({ tone: "watch", text: `${highPriority.length} high priority item${highPriority.length === 1 ? "" : "s"} still open` });
    }
    if (!signals.length) {
      signals.push({ tone: "info", text: "No obvious risk signal from current Jira fields" });
    }

    return {
      assignee,
      total: assigneeIssues.length,
      stories: stories.length,
      tasks: tasks.length,
      active: active.length,
      done: done.length,
      blocked: blocked.length,
      overdue: overdue.length,
      stale: stale.length,
      focusIssues,
      signals: signals.slice(0, 4),
      agentStatus,
      nextAction: assigneeNextAction({ blocked, overdue, stale, review, active, agentStatus }),
      assistantAdvice: adviceByAssignee[assignee] || buildAssistantAdvice({
        assignee,
        blocked,
        overdue,
        stale,
        review,
        highPriority,
        active,
        focusIssues,
        agentStatus
      }),
      tone: assigneeTone({ blocked, overdue, stale, active, agentStatus })
    };
  }).sort((a, b) => {
    return b.blocked - a.blocked ||
      b.overdue - a.overdue ||
      b.stale - a.stale ||
      b.active - a.active ||
      b.total - a.total ||
      a.assignee.localeCompare(b.assignee);
  });
}

/**
 * @param {any} summary
 */
function renderAssigneeTile(summary) {
  return `<article class="tile">
  <div class="tile-header">
    <div class="name">${escapeHtml(summary.assignee)}</div>
    <span class="tone ${escapeHtml(summary.tone)}" aria-hidden="true"></span>
  </div>

  <div class="metrics">
    ${renderMetric(summary.stories, "Stories")}
    ${renderMetric(summary.tasks, "Tasks")}
    ${renderMetric(summary.active, "Active")}
    ${renderMetric(summary.blocked, "Blocked")}
    ${renderMetric(summary.done, "Done")}
    ${renderMetric(summary.total, "Total")}
  </div>

  ${renderAgentStatus(summary.agentStatus)}

  <section class="focus">
    <h2 class="section-title">Current Focus</h2>
    ${renderFocusIssues(summary.focusIssues)}
  </section>

  <section>
    <h2 class="section-title">Signals</h2>
    <div class="signals">
      ${summary.signals.map((signal) => `<div class="signal"><span class="signal-mark ${escapeHtml(signal.tone)}"></span><span>${escapeHtml(signal.text)}</span></div>`).join("\n")}
    </div>
  </section>

  <section class="assistant-advice">
    <h2 class="section-title">AI Assistant Advice</h2>
    <textarea class="advice-input" data-assignee="${escapeHtml(summary.assignee)}" spellcheck="false">${escapeHtml(summary.assistantAdvice || "")}</textarea>
  </section>

  <div class="next">${escapeHtml(summary.nextAction)}</div>
</article>`;
}

/**
 * @param {any} status
 */
function renderAgentStatus(status) {
  if (!status || !status.isAgent) {
    return "";
  }

  return `<section class="agent-strip">
    <div class="agent-heading">
      <span class="agent-label">AI Agent</span>
      <span class="agent-badge ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
    </div>
    <div class="agent-text">${escapeHtml(status.text)}</div>
  </section>`;
}

/**
 * @param {number} value
 * @param {string} label
 */
function renderMetric(value, label) {
  return `<div class="metric"><span class="metric-value">${value}</span><span class="metric-label">${escapeHtml(label)}</span></div>`;
}

/**
 * @param {Array<any>} issues
 */
function renderFocusIssues(issues) {
  if (!issues.length) {
    return `<div class="signals"><div class="signal"><span class="signal-mark info"></span><span>No active issue assigned.</span></div></div>`;
  }

  return `<ul class="issue-list">
    ${issues.map((issue) => `<li class="issue"><span class="issue-key">${escapeHtml(issue.key)}</span><span class="issue-text">${escapeHtml(issue.summary)}</span></li>`).join("\n")}
  </ul>`;
}

/**
 * @param {{ blocked: Array<any>, overdue: Array<any>, stale: Array<any>, review: Array<any>, active: Array<any>, agentStatus?: any }} input
 */
function assigneeNextAction(input) {
  if (input.agentStatus && input.agentStatus.isAgent) {
    if (input.agentStatus.state === "needsApproval") {
      return "Next: review the requested permission or decision, then unblock or cancel the agent run.";
    }
    if (input.agentStatus.state === "running") {
      return "Next: check whether the agent has fresh progress and a clear next handoff.";
    }
    if (input.agentStatus.state === "failed") {
      return "Next: inspect the failed run, capture the reason, and decide whether to retry or reassign.";
    }
    if (input.agentStatus.state === "completed") {
      return "Next: review the output and close or move the related Jira work forward.";
    }
  }
  if (input.blocked.length) {
    return "Next: unblock or confirm the dependency owner today.";
  }
  if (input.overdue.length) {
    return "Next: decide whether to finish, defer, or descope overdue work.";
  }
  if (input.stale.length) {
    return "Next: ask for a status update or split the stale item.";
  }
  if (input.review.length) {
    return "Next: clarify reviewer and acceptance checks.";
  }
  if (input.active.length) {
    return "Next: confirm the issue most likely to finish next.";
  }
  return "Next: confirm whether this person has sprint capacity available.";
}

/**
 * @param {{ assignee: string, blocked: Array<any>, overdue: Array<any>, stale: Array<any>, review: Array<any>, highPriority: Array<any>, active: Array<any>, focusIssues: Array<any>, agentStatus?: any }} input
 */
function buildAssistantAdvice(input) {
  const focus = input.focusIssues[0];
  const focusText = focus ? `${focus.key}: ${focus.summary}` : "available sprint capacity";

  if (input.agentStatus && input.agentStatus.isAgent) {
    if (input.agentStatus.state === "needsApproval") {
      return `${input.assignee} appears paused for approval. Review the requested permission or decision before asking it to continue.`;
    }
    if (input.agentStatus.state === "running") {
      return `${input.assignee} appears to be running. Check for recent progress, expected completion, and the next human handoff.`;
    }
    if (input.agentStatus.state === "failed") {
      return `${input.assignee} appears to have a failed run. Capture the failure reason before retrying or reassigning the issue.`;
    }
    if (input.agentStatus.state === "completed") {
      return `${input.assignee} appears to have completed its assigned work. Review the output and move the Jira issue to the next state.`;
    }
  }

  if (input.blocked.length) {
    const issue = input.blocked[0];
    return `Start with ${issue.key}. Ask ${input.assignee} what decision, dependency, or owner is needed to unblock it, then record the next owner and date in Jira.`;
  }

  if (input.overdue.length) {
    const issue = input.overdue[0];
    return `${issue.key} is overdue. Decide today whether it will finish in this sprint, move out, or be reduced in scope.`;
  }

  if (input.stale.length) {
    const issue = input.stale[0];
    return `${issue.key} has not moved recently. Ask for a concrete status update and split it if the remaining work is larger than one day.`;
  }

  if (input.review.length) {
    const issue = input.review[0];
    return `${issue.key} looks ready for review or QA. Confirm the reviewer, acceptance checks, and the expected completion time.`;
  }

  if (input.highPriority.length) {
    const issue = input.highPriority[0];
    return `${issue.key} is the highest-priority open item. Keep the daily conversation focused on what must happen next for this to close.`;
  }

  if (input.active.length > 2) {
    return `${input.assignee} has ${input.active.length} active items. Reduce context switching by naming one finish-first issue: ${focusText}.`;
  }

  if (input.active.length) {
    return `Keep focus on ${focusText}. Ask what remains, what can finish today, and whether any help is needed.`;
  }

  return `${input.assignee} has no active assigned work in this view. Confirm capacity or whether Jira assignments are missing.`;
}

/**
 * @param {{ blocked: Array<any>, overdue: Array<any>, stale: Array<any>, active: Array<any>, agentStatus?: any }} input
 */
function assigneeTone(input) {
  if (input.agentStatus && input.agentStatus.isAgent) {
    if (input.agentStatus.state === "needsApproval" || input.agentStatus.state === "failed") {
      return "risk";
    }
    if (input.agentStatus.state === "running") {
      return "info";
    }
    if (input.agentStatus.state === "completed") {
      return "ok";
    }
  }
  if (input.blocked.length || input.overdue.length) {
    return "risk";
  }
  if (input.stale.length) {
    return "watch";
  }
  if (input.active.length) {
    return "info";
  }
  return "ok";
}

/**
 * @param {string} assignee
 * @param {Array<any>} assigneeIssues
 * @param {Array<any>} active
 * @param {Array<any>} done
 */
function buildAgentStatus(assignee, assigneeIssues, active, done) {
  if (!isAiAgentAssignee(assignee, assigneeIssues)) {
    return { isAgent: false };
  }

  const combinedText = agentSearchText(assigneeIssues);
  if (/approval|approve|permission|authorize|consent|human[- ]?approval|needs[- ]?approval|waiting[- ]for[- ]approval/i.test(combinedText)) {
    return {
      isAgent: true,
      state: "needsApproval",
      label: "Needs approval",
      tone: "risk",
      signal: "AI agent is paused for human approval or permission",
      text: "A human approval, permission, or decision appears to be blocking the next agent step."
    };
  }

  if (/failed|failure|error|exception|crash|cancelled|canceled|timed[- ]?out|timeout/i.test(combinedText)) {
    return {
      isAgent: true,
      state: "failed",
      label: "Failed",
      tone: "risk",
      signal: "AI agent has a failed or interrupted run signal",
      text: "The current Jira fields suggest a failed, cancelled, timed-out, or errored agent run."
    };
  }

  if (active.some((issue) => /in progress|running|executing|working|active/i.test(`${issue.status} ${issue.labels.join(" ")}`))) {
    return {
      isAgent: true,
      state: "running",
      label: "Running",
      tone: "info",
      signal: "AI agent appears to be actively running",
      text: "The agent has active work in progress. Check recent updates and expected handoff."
    };
  }

  if (!active.length && done.length) {
    return {
      isAgent: true,
      state: "completed",
      label: "Completed",
      tone: "ok",
      signal: "AI agent assigned work is completed",
      text: "All visible work for this agent is done. Review outputs before closing the loop."
    };
  }

  return {
    isAgent: true,
    state: "idle",
    label: "Idle",
    tone: "watch",
    signal: "AI agent has no clear running signal",
    text: "This assignee looks like an AI agent, but Jira does not show an active run state."
  };
}

/**
 * @param {string} assignee
 * @param {Array<any>} issues
 */
function isAiAgentAssignee(assignee, issues) {
  const text = [
    assignee,
    issues.map((issue) => issue.labels.join(" ")).join(" "),
    issues.map((issue) => issue.components.join(" ")).join(" ")
  ].join(" ");
  return /\b(ai|agent|bot|copilot|codex|automation|autonomous)\b/i.test(text);
}

/**
 * @param {Array<any>} issues
 */
function agentSearchText(issues) {
  return issues.map((issue) => [
    issue.key,
    issue.summary,
    issue.status,
    issue.priority,
    issue.labels.join(" "),
    issue.components.join(" "),
    issue.links.join(" "),
    issue.comments.map((comment) => comment.body).join(" "),
    issue.changelog.flatMap((history) => history.items).join(" ")
  ].join(" ")).join(" ");
}

/**
 * @param {any} a
 * @param {any} b
 */
function compareIssuesForFocus(a, b) {
  return issueFocusScore(b) - issueFocusScore(a) ||
    b.daysSinceUpdated - a.daysSinceUpdated ||
    a.key.localeCompare(b.key);
}

/**
 * @param {any} issue
 */
function issueFocusScore(issue) {
  let score = 0;
  if (isBlockedDigest(issue)) {
    score += 50;
  }
  if (issue.dueDate && isPastDate(issue.dueDate)) {
    score += 40;
  }
  if (/highest|high|critical|blocker/i.test(issue.priority)) {
    score += 25;
  }
  if (issue.daysSinceUpdated >= 3) {
    score += 15;
  }
  if (/review|qa|test/i.test(issue.status)) {
    score += 10;
  }
  return score;
}

/**
 * @param {Array<any>} issues
 * @param {string} title
 */
function riskLines(title, issues) {
  return issues.slice(0, 12).map((issue) => {
    const due = issue.dueDate ? `, due ${issue.dueDate}` : "";
    return `- ${title}: ${issue.key} ${issue.summary} (${issue.status}, ${issue.assignee}${due})`;
  });
}

/**
 * @param {Array<any>} blocked
 * @param {Array<any>} stale
 * @param {Array<any>} review
 * @param {Array<any>} unassigned
 */
function questionLines(blocked, stale, review, unassigned) {
  const lines = [];
  if (blocked.length) {
    lines.push(`- Confirm the owner, dependency, and target resolution date for ${blocked.length} blocker candidate(s).`);
  }
  if (stale.length) {
    lines.push(`- Check whether ${stale.length} stale active issue(s) are still in progress or waiting on input.`);
  }
  if (review.length) {
    lines.push(`- Confirm who should move next on ${review.length} review or QA item(s).`);
  }
  if (unassigned.length) {
    lines.push(`- Decide the owner or scope tradeoff for ${unassigned.length} unassigned issue(s).`);
  }
  if (!lines.length) {
    lines.push("- Ask each assignee to confirm items that can finish today, items still at risk, and any support needed.");
  }
  return lines;
}

/**
 * @param {Array<any>} blocked
 * @param {Array<any>} overdue
 * @param {Array<any>} stale
 * @param {Array<any>} review
 * @param {Array<any>} unassigned
 */
function nextActionLines(blocked, overdue, stale, review, unassigned) {
  const lines = [];
  if (blocked.length) {
    lines.push("- Make blocker candidates visible on the sprint board and add the resolution owner and target date to the issue comments.");
  }
  if (overdue.length) {
    lines.push("- Decide today whether each overdue issue will be completed, deferred, or descoped.");
  }
  if (stale.length) {
    lines.push("- Ask assignees for status updates or a split plan on active issues with no update for 3+ days.");
  }
  if (review.length) {
    lines.push("- Clarify the reviewer, QA criteria, and expected turnaround time for review or QA items.");
  }
  if (unassigned.length) {
    lines.push("- Assign owners for unassigned issues or move them out of the sprint scope.");
  }
  if (!lines.length) {
    lines.push("- Review issues tied directly to the sprint goal first, then confirm done criteria and remaining risks.");
  }
  return lines;
}

/**
 * @param {any} issue
 */
function toIssueDigest(issue) {
  const fields = issue.fields || {};
  const comments = (fields.comment && Array.isArray(fields.comment.comments) ? fields.comment.comments : [])
    .slice(-3)
    .map((comment) => ({
      author: comment.author && comment.author.displayName ? comment.author.displayName : "Unknown",
      created: comment.created ? formatDate(comment.created) : "",
      body: trimText(adfToText(comment.body), 500)
    }));
  const changelog = issue.changelog && Array.isArray(issue.changelog.histories)
    ? issue.changelog.histories.slice(-5).map((history) => ({
      author: history.author && history.author.displayName ? history.author.displayName : "Unknown",
      created: history.created ? formatDate(history.created) : "",
      items: Array.isArray(history.items)
        ? history.items.map((item) => `${item.field}: ${item.fromString || "-"} -> ${item.toString || "-"}`)
        : []
    }))
    : [];
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks.map(linkSummary).filter(Boolean) : [];

  const updatedDate = fields.updated ? formatDate(fields.updated) : "";
  const statusCategory = fields.status && fields.status.statusCategory ? fields.status.statusCategory.key : "";
  const status = fields.status && fields.status.name ? fields.status.name : "Unknown";

  return {
    key: issue.key || "UNKNOWN",
    summary: fields.summary || "(no summary)",
    type: fields.issuetype && fields.issuetype.name ? fields.issuetype.name : "Issue",
    status,
    statusCategory,
    isDone: statusCategory === "done" || /done|closed|resolved/i.test(status),
    assignee: fields.assignee && fields.assignee.displayName ? fields.assignee.displayName : "Unassigned",
    reporter: fields.reporter && fields.reporter.displayName ? fields.reporter.displayName : "Unknown",
    priority: fields.priority && fields.priority.name ? fields.priority.name : "None",
    createdDate: fields.created ? formatDate(fields.created) : "",
    updatedDate,
    daysSinceUpdated: fields.updated ? daysSince(fields.updated) : 0,
    dueDate: fields.duedate || "",
    labels,
    components: Array.isArray(fields.components) ? fields.components.map((component) => component.name).filter(Boolean) : [],
    fixVersions: Array.isArray(fields.fixVersions) ? fields.fixVersions.map((version) => version.name).filter(Boolean) : [],
    parent: fields.parent ? `${fields.parent.key} ${fields.parent.fields && fields.parent.fields.summary ? fields.parent.fields.summary : ""}`.trim() : "",
    comments,
    changelog,
    links
  };
}

/**
 * @param {any} link
 */
function linkSummary(link) {
  if (link.outwardIssue) {
    return `${link.type && link.type.outward ? link.type.outward : "relates to"} ${link.outwardIssue.key}`;
  }
  if (link.inwardIssue) {
    return `${link.type && link.type.inward ? link.type.inward : "relates to"} ${link.inwardIssue.key}`;
  }
  return "";
}

/**
 * @param {any} digest
 */
function isBlockedDigest(digest) {
  const text = [
    digest.status,
    digest.summary,
    digest.labels.join(" "),
    digest.links.join(" "),
    digest.comments.map((comment) => comment.body).join(" ")
  ].join(" ");
  return /block|blocked|blocking|impediment|waiting|dependency/i.test(text);
}

/**
 * @param {any} value
 */
function adfToText(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(adfToText).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (value.content) {
      return adfToText(value.content);
    }
  }
  return "";
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
 * @param {Array<any>} items
 * @param {string} key
 */
function mapCounts(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key] || "Unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * @param {Array<any>} issues
 * @param {Array<any>} digests
 */
function buildSprintTimingSummary(issues, digests) {
  const sprint = collectSprintCandidates(issues)
    .filter((candidate) => candidate.endDate)
    .sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime())[0];

  if (sprint) {
    const remainingDays = daysUntilEnd(sprint.endDate);
    const endDate = dateLabel(sprint.endDate);
    const name = sprint.name ? `${sprint.name} ` : "";
    return {
      remainingText: formatRemainingDays(remainingDays),
      description: `${name}ends on ${endDate}. ${remainingDays === 0 ? "No days remain in the target sprint." : `${remainingDays} day${remainingDays === 1 ? "" : "s"} remain in the target sprint.`}`
    };
  }

  const fallbackDueDate = digests
    .filter((issue) => !issue.isDone && issue.dueDate)
    .map((issue) => issue.dueDate)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  if (fallbackDueDate) {
    const remainingDays = daysUntilEnd(fallbackDueDate);
    return {
      remainingText: formatRemainingDays(remainingDays),
      description: `Sprint end date was not found in Jira fields, so the latest active issue due date (${dateLabel(fallbackDueDate)}) is being used.`
    };
  }

  return {
    remainingText: "N/A",
    description: "Sprint end date was not found in Jira fields. Include the Jira sprint field in the search result to show remaining days."
  };
}

/**
 * Keep model prompts intentionally smaller than the full local digest. Comments,
 * changelog entries, reporter names, and Jira account metadata can contain
 * sensitive personal or customer data, so they stay local.
 *
 * @param {any} issue
 */
function toAiIssueDigest(issue) {
  const digest = toIssueDigest(issue);
  return {
    key: digest.key,
    summary: digest.summary,
    type: digest.type,
    status: digest.status,
    isDone: digest.isDone,
    assignee: digest.assignee,
    priority: digest.priority,
    createdDate: digest.createdDate,
    updatedDate: digest.updatedDate,
    daysSinceUpdated: digest.daysSinceUpdated,
    dueDate: digest.dueDate,
    labels: digest.labels,
    components: digest.components,
    fixVersions: digest.fixVersions,
    parent: digest.parent,
    links: digest.links
  };
}

/**
 * @param {Array<any>} issues
 */
function collectSprintCandidates(issues) {
  const candidates = [];
  for (const issue of issues) {
    collectSprintValues(issue.fields || {}, candidates);
  }
  return candidates;
}

/**
 * @param {any} value
 * @param {Array<any>} candidates
 */
function collectSprintValues(value, candidates) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSprintValues(item, candidates);
    }
    return;
  }
  if (typeof value === "string") {
    const parsed = parseSprintString(value);
    if (parsed) {
      candidates.push(parsed);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  if (value.endDate || value.startDate || (value.name && value.state && /sprint/i.test(String(value.self || value.name)))) {
    candidates.push({
      name: value.name || "",
      state: value.state || "",
      startDate: value.startDate || "",
      endDate: value.endDate || ""
    });
  }

  for (const nested of Object.values(value)) {
    collectSprintValues(nested, candidates);
  }
}

/**
 * @param {string} value
 */
function parseSprintString(value) {
  if (!/sprint/i.test(value) || !/endDate=/.test(value)) {
    return undefined;
  }
  return {
    name: sprintStringField(value, "name"),
    state: sprintStringField(value, "state"),
    startDate: sprintStringField(value, "startDate"),
    endDate: sprintStringField(value, "endDate")
  };
}

/**
 * @param {string} value
 * @param {string} key
 */
function sprintStringField(value, key) {
  const match = value.match(new RegExp(`${key}=([^,\\]]*)`));
  return match ? match[1] : "";
}

/**
 * @param {string} value
 */
function daysUntilEnd(value) {
  const hasTime = /T/.test(value);
  const date = new Date(hasTime ? value : `${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * @param {number} days
 */
function formatRemainingDays(days) {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * @param {string} value
 */
function dateLabel(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : formatDate(value);
}

/**
 * @param {string} type
 */
function isStoryIssueType(type) {
  return /^story$/i.test(type);
}

/**
 * @param {string} type
 */
function isTaskIssueType(type) {
  return /^(task|sub-task|subtask)$/i.test(type);
}

/**
 * @param {string} value
 */
function isPastDate(value) {
  const date = new Date(`${value}T23:59:59`);
  return !Number.isNaN(date.getTime()) && date < new Date();
}

/**
 * @param {string} value
 */
function daysSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * @param {string} value
 */
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * @param {Date} value
 */
function formatTime(value) {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * @param {string} value
 * @param {number} maxLength
 */
function trimText(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

/**
 * @param {string} value
 * @param {number} [maxLength]
 */
function trimForTree(value, maxLength = 64) {
  return trimText(value, maxLength);
}

/**
 * @param {string} value
 */
function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * @param {unknown} value
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {unknown} value
 */
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function getNonce() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * @param {any} issue
 */
function issueIcon(issue) {
  if (issue.isDone) {
    return "pass";
  }
  if (isBlockedDigest(issue)) {
    return "error";
  }
  if (issue.assignee === "Unassigned") {
    return "warning";
  }
  return "circle-large-outline";
}

/**
 * @param {unknown} error
 */
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  activate,
  deactivate,
  _test: {
    loadSampleIssues,
    normalizeBaseUrl,
    normalizeTokenBrokerUrl,
    isJiraCloudHost
  }
};
