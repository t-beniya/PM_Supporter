// @ts-check

const { sanitizeText } = require("./sanitize");
const {
  isBlockedDigest,
  isPastDate,
  mapCounts,
  toAiIssueDigest,
  toIssueDigest
} = require("./issueDigest");

/**
 * @param {Array<any>} issues
 * @param {{ jql?: string, source?: string }} [options]
 */
function buildSprintBriefPrompt(issues, options = {}) {
  const jql = sanitizeText(options.jql || "", 1000);
  const source = options.source ? sanitizeText(options.source, 200) : "";
  const issueDigests = issues.map(toAiIssueDigest);
  return [
    "You are an expert Project Manager and Scrum Master.",
    "Write concise Japanese Markdown for a daily sprint brief.",
    "Focus on current status, risks, blockers, follow-up questions, and concrete next actions.",
    "Do not invent issue details that are not present in the supplied Jira data.",
    "Use these sections: Summary, Status Breakdown, Risks, Blockers, Daily Scrum Questions, Next Actions, Issue Snapshot.",
    "",
    ...(source ? [`Source: ${source}`, ""] : []),
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
  const jql = sanitizeText(options.jql || "", 1000);
  const source = options.source ? sanitizeText(options.source, 200) : "";
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
    ...(source ? [`Source: ${source}`] : []),
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
 * @param {string} value
 */
function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

module.exports = {
  buildLocalSprintBrief,
  buildSprintBriefPrompt
};
