// @ts-check

const crypto = require("crypto");
const {
  buildSprintTimingSummary,
  isBlockedDigest,
  isPastDate,
  isStoryIssueType,
  isTaskIssueType,
  toIssueDigest
} = require("./issueDigest");

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI PM Assignee Tiles</title>
  <style nonce="${nonce}">
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

    function text(value) {
      return String(value ?? "");
    }

    function node(tagName, className, textContent) {
      const element = document.createElement(tagName);
      if (className) {
        element.className = className;
      }
      if (textContent !== undefined) {
        element.textContent = text(textContent);
      }
      return element;
    }

    function addToneClass(element, tone) {
      const safeTone = text(tone);
      if (["risk", "watch", "info", "ok"].includes(safeTone)) {
        element.classList.add(safeTone);
      }
    }

    function metric(value, label) {
      const wrapper = node("div", "metric");
      wrapper.append(
        node("span", "metric-value", value),
        node("span", "metric-label", label)
      );
      return wrapper;
    }

    function signalRow(tone, message) {
      const wrapper = node("div", "signal");
      const mark = node("span", "signal-mark");
      addToneClass(mark, tone);
      wrapper.append(mark, node("span", "", message));
      return wrapper;
    }

    function focusIssues(issues) {
      if (!issues.length) {
        const signals = node("div", "signals");
        signals.append(signalRow("info", "No active issue assigned."));
        return signals;
      }

      const list = node("ul", "issue-list");
      for (const issue of issues) {
        const item = node("li", "issue");
        item.append(
          node("span", "issue-key", issue.key),
          node("span", "issue-text", issue.summary)
        );
        list.append(item);
      }
      return list;
    }

    function agentStrip(summary) {
      if (!summary.agentStatus || !summary.agentStatus.isAgent) {
        return null;
      }
      const status = summary.agentStatus;
      const section = node("section", "agent-strip");
      const heading = node("div", "agent-heading");
      const badge = node("span", "agent-badge", status.label);
      addToneClass(badge, status.tone);
      heading.append(node("span", "agent-label", "AI Agent"), badge);
      section.append(heading, node("div", "agent-text", status.text));
      return section;
    }

    function advice(summary) {
      const section = node("section", "assistant-advice");
      const textarea = node("textarea", "advice-input");
      textarea.dataset.assignee = text(summary.assignee);
      textarea.spellcheck = false;
      textarea.value = text(adviceByAssignee[summary.assignee] ?? summary.assistantAdvice ?? "");
      section.append(
        node("h2", "section-title", "AI Assistant Advice"),
        textarea
      );
      return section;
    }

    function tile(summary) {
      const article = node("article", "tile");
      const header = node("div", "tile-header");
      const tone = node("span", "tone");
      tone.setAttribute("aria-hidden", "true");
      addToneClass(tone, summary.tone);
      header.append(node("div", "name", summary.assignee), tone);

      const metrics = node("div", "metrics");
      metrics.append(
        metric(summary.stories, "Stories"),
        metric(summary.tasks, "Tasks"),
        metric(summary.active, "Active"),
        metric(summary.blocked, "Blocked"),
        metric(summary.done, "Done"),
        metric(summary.total, "Total")
      );

      const focus = node("section", "focus");
      focus.append(node("h2", "section-title", "Current Focus"), focusIssues(summary.focusIssues));

      const signalsSection = node("section");
      const signals = node("div", "signals");
      for (const signal of summary.signals) {
        signals.append(signalRow(signal.tone, signal.text));
      }
      signalsSection.append(node("h2", "section-title", "Signals"), signals);

      const agent = agentStrip(summary);
      article.append(header, metrics);
      if (agent) {
        article.append(agent);
      }
      article.append(
        focus,
        signalsSection,
        advice(summary),
        node("div", "next", summary.nextAction)
      );
      return article;
    }

    function renderPage() {
      const pageCount = Math.max(1, Math.ceil(assigneePages.length / pageSize));
      currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
      const start = currentPage * pageSize;
      grid.replaceChildren(...assigneePages.slice(start, start + pageSize).map(tile));
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
      assistantAdvice: getSafeProperty(adviceByAssignee, assignee) || buildAssistantAdvice({
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
  return '<article class="tile">' +
    '<div class="tile-header">' +
      '<div class="name">' + escapeHtml(summary.assignee) + '</div>' +
      '<span class="tone ' + escapeHtml(summary.tone) + '" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="metrics">' +
      renderMetric(summary.stories, "Stories") +
      renderMetric(summary.tasks, "Tasks") +
      renderMetric(summary.active, "Active") +
      renderMetric(summary.blocked, "Blocked") +
      renderMetric(summary.done, "Done") +
      renderMetric(summary.total, "Total") +
    '</div>' +
    renderAgentStatus(summary.agentStatus) +
    '<section class="focus">' +
      '<h2 class="section-title">Current Focus</h2>' +
      renderFocusIssues(summary.focusIssues) +
    '</section>' +
    '<section>' +
      '<h2 class="section-title">Signals</h2>' +
      '<div class="signals">' +
        summary.signals.map((signal) => '<div class="signal"><span class="signal-mark ' + escapeHtml(signal.tone) + '"></span><span>' + escapeHtml(signal.text) + '</span></div>').join('\n') +
      '</div>' +
    '</section>' +
    '<section class="assistant-advice">' +
      '<h2 class="section-title">AI Assistant Advice</h2>' +
      '<textarea class="advice-input" data-assignee="' + escapeHtml(summary.assignee) + '" spellcheck="false">' + escapeHtml(summary.assistantAdvice || "") + '</textarea>' +
    '</section>' +
    '<div class="next">' + escapeHtml(summary.nextAction) + '</div>' +
  '</article>';
}

/**
 * @param {any} status
 */
function renderAgentStatus(status) {
  if (!status || !status.isAgent) {
    return "";
  }

  return '<section class="agent-strip">' +
    '<div class="agent-heading">' +
      '<span class="agent-label">AI Agent</span>' +
      '<span class="agent-badge ' + escapeHtml(status.tone) + '">' + escapeHtml(status.label) + '</span>' +
    '</div>' +
    '<div class="agent-text">' + escapeHtml(status.text) + '</div>' +
  '</section>';
}

/**
 * @param {number} value
 * @param {string} label
 */
function renderMetric(value, label) {
  return '<div class="metric"><span class="metric-value">' + escapeHtml(value) + '</span><span class="metric-label">' + escapeHtml(label) + '</span></div>';
}

/**
 * @param {Array<any>} issues
 */
function renderFocusIssues(issues) {
  if (!issues.length) {
    return '<div class="signals"><div class="signal"><span class="signal-mark info"></span><span>No active issue assigned.</span></div></div>';
  }

  return '<ul class="issue-list">' +
    issues.map((issue) => '<li class="issue"><span class="issue-key">' + escapeHtml(issue.key) + '</span><span class="issue-text">' + escapeHtml(issue.summary) + '</span></li>').join('\n') +
  '</ul>';
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
 * @param {Record<string, any>} obj
 * @param {string} key
 */
function getSafeProperty(obj, key) {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
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

module.exports = {
  buildAssigneeSummaries,
  buildAssigneeTilesHtml
};
