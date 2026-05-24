// @ts-check

const {
  sanitizeList,
  sanitizeText
} = require("./sanitize");

/**
 * @param {any} issue
 */
function toIssueDigest(issue) {
  const fields = issue.fields || {};
  const comments = (fields.comment && Array.isArray(fields.comment.comments) ? fields.comment.comments : [])
    .slice(-3)
    .map((comment) => ({
      author: sanitizeText(comment.author && comment.author.displayName ? comment.author.displayName : "Unknown", 120),
      created: comment.created ? formatDate(comment.created) : "",
      body: sanitizeText(adfToText(comment.body), 500)
    }));
  const changelog = issue.changelog && Array.isArray(issue.changelog.histories)
    ? issue.changelog.histories.slice(-5).map((history) => ({
      author: sanitizeText(history.author && history.author.displayName ? history.author.displayName : "Unknown", 120),
      created: history.created ? formatDate(history.created) : "",
      items: Array.isArray(history.items)
        ? history.items.map((item) => sanitizeText(`${item.field}: ${item.fromString || "-"} -> ${item.toString || "-"}`, 200))
        : []
    }))
    : [];
  const labels = sanitizeList(fields.labels, 80, 30);
  const links = sanitizeList(Array.isArray(fields.issuelinks) ? fields.issuelinks.map(linkSummary).filter(Boolean) : [], 120, 20);

  const updatedDate = fields.updated ? formatDate(fields.updated) : "";
  const statusCategory = fields.status && fields.status.statusCategory ? fields.status.statusCategory.key : "";
  const status = fields.status && fields.status.name ? fields.status.name : "Unknown";

  return {
    key: sanitizeText(issue.key || "UNKNOWN", 80),
    summary: sanitizeText(fields.summary || "(no summary)", 300),
    type: sanitizeText(fields.issuetype && fields.issuetype.name ? fields.issuetype.name : "Issue", 80),
    status: sanitizeText(status, 120),
    statusCategory,
    isDone: statusCategory === "done" || /done|closed|resolved/i.test(status),
    assignee: sanitizeText(fields.assignee && fields.assignee.displayName ? fields.assignee.displayName : "Unassigned", 120),
    reporter: sanitizeText(fields.reporter && fields.reporter.displayName ? fields.reporter.displayName : "Unknown", 120),
    priority: sanitizeText(fields.priority && fields.priority.name ? fields.priority.name : "None", 80),
    createdDate: fields.created ? formatDate(fields.created) : "",
    updatedDate,
    daysSinceUpdated: fields.updated ? daysSince(fields.updated) : 0,
    dueDate: fields.duedate || "",
    labels,
    components: sanitizeList(Array.isArray(fields.components) ? fields.components.map((component) => component.name).filter(Boolean) : [], 120, 20),
    fixVersions: sanitizeList(Array.isArray(fields.fixVersions) ? fields.fixVersions.map((version) => version.name).filter(Boolean) : [], 120, 20),
    parent: fields.parent ? sanitizeText(`${fields.parent.key} ${fields.parent.fields && fields.parent.fields.summary ? fields.parent.fields.summary : ""}`, 300) : "",
    comments,
    changelog,
    links
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
  if (typeof value !== "string" || !value) {
    return "";
  }
  const prefix = `${key}=`;
  const idx = value.indexOf(prefix);
  if (idx === -1) {
    return "";
  }
  const start = idx + prefix.length;
  let end = value.length;
  for (let i = start; i < value.length; i++) {
    if (value[i] === "," || value[i] === "]") {
      end = i;
      break;
    }
  }
  return value.slice(start, end);
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
 * @param {Array<any>} items
 * @param {string} key
 */
function mapCounts(items, key) {
  const counts = new Map();
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    return [];
  }
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const value = Object.prototype.hasOwnProperty.call(item, key) ? item[key] : "Unknown";
    const stringValue = value !== undefined && value !== null ? String(value) : "Unknown";
    counts.set(stringValue, (counts.get(stringValue) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
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

module.exports = {
  buildSprintTimingSummary,
  formatTime,
  isBlockedDigest,
  isPastDate,
  isStoryIssueType,
  isTaskIssueType,
  issueIcon,
  mapCounts,
  toAiIssueDigest,
  toIssueDigest,
  trimForTree
};
