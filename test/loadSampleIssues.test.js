const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {
      TreeItem: class TreeItem {
        constructor(label, collapsibleState) {
          this.label = label;
          this.collapsibleState = collapsibleState;
        }
      },
      ThemeIcon: class ThemeIcon {
        constructor(id) {
          this.id = id;
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require("../extension");
Module._load = originalLoad;

test("loadSampleIssues returns bundled sample issues", () => {
  const issues = _test.loadSampleIssues({ extensionPath: path.join(__dirname, "..") });

  assert.ok(Array.isArray(issues));
  assert.ok(issues.length > 0);
  assert.equal(typeof issues[0].key, "string");
});

test("loadSampleIssues fails when sample file is missing", (t) => {
  const extensionPath = makeExtensionFixture(t);

  assert.throws(
    () => _test.loadSampleIssues({ extensionPath }),
    /ENOENT/
  );
});

test("loadSampleIssues fails when sample JSON is invalid", (t) => {
  const extensionPath = makeExtensionFixture(t, "{ invalid json");

  assert.throws(
    () => _test.loadSampleIssues({ extensionPath }),
    /Unexpected token|Expected property name/
  );
});

test("loadSampleIssues fails when issues is missing", (t) => {
  const extensionPath = makeExtensionFixture(t, JSON.stringify({ total: 0 }));

  assert.throws(
    () => _test.loadSampleIssues({ extensionPath }),
    /did not include an issues array/
  );
});

test("loadSampleIssues fails when issues is empty", (t) => {
  const extensionPath = makeExtensionFixture(t, JSON.stringify({ issues: [] }));

  assert.throws(
    () => _test.loadSampleIssues({ extensionPath }),
    /did not include any issues/
  );
});

test("normalizeBaseUrl accepts Jira Cloud HTTPS origins", () => {
  assert.equal(_test.normalizeBaseUrl("https://example.atlassian.net/path?x=1"), "https://example.atlassian.net");
});

test("normalizeBaseUrl rejects non-Jira Cloud hosts before credentials are sent", () => {
  assert.throws(
    () => _test.normalizeBaseUrl("https://example.com"),
    /Only Jira Cloud hosts/
  );
});

test("normalizeBaseUrl rejects URLs with embedded credentials", () => {
  assert.throws(
    () => _test.normalizeBaseUrl("https://user:token@example.atlassian.net"),
    /Do not include credentials/
  );
});

test("normalizeBaseUrl rejects insecure URLs", () => {
  assert.throws(
    () => _test.normalizeBaseUrl("http://example.atlassian.net"),
    /must use HTTPS/
  );
});

test("normalizeTokenBrokerUrl accepts HTTPS endpoints", () => {
  assert.equal(
    _test.normalizeTokenBrokerUrl("https://broker.example.com/atlassian/oauth/token#ignored"),
    "https://broker.example.com/atlassian/oauth/token"
  );
});

test("normalizeTokenBrokerUrl rejects insecure endpoints", () => {
  assert.throws(
    () => _test.normalizeTokenBrokerUrl("http://broker.example.com/token"),
    /must use HTTPS/
  );
});

test("normalizeTokenBrokerUrl rejects embedded credentials", () => {
  assert.throws(
    () => _test.normalizeTokenBrokerUrl("https://user:secret@broker.example.com/token"),
    /Do not include credentials/
  );
});

function makeExtensionFixture(t, sampleText) {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), "jira-ai-pm-test-"));
  const samplesPath = path.join(extensionPath, "samples");
  fs.mkdirSync(samplesPath);

  if (sampleText !== undefined) {
    fs.writeFileSync(path.join(samplesPath, "jira-sprint.json"), sampleText, "utf8");
  }

  t.after(() => {
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  return extensionPath;
}
