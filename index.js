const { createHmac } = require("node:crypto");
const { appendFileSync } = require("node:fs");

const POLL_INTERVAL_MS = 15000;
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_POLL_FAILURES = 5;
const REQUEST_BODY = "{}";

function readInput(name, fallback) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = (process.env[key] ?? "").trim();
  return value === "" ? fallback : value;
}

function setOutput(name, value) {
  if (value === undefined || value === null) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendFileSync(outputFile, `${name}=${value}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sign(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function requestWithRateLimitRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
    const retryAfterSeconds = Number(response.headers.get("retry-after")) || 60;
    console.log(`Rate limited by Regress. Retrying in ${retryAfterSeconds}s.`);
    await sleep(retryAfterSeconds * 1000);
  }
}

async function readBody(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function startScan({ apiUrl, projectId, secret }) {
  const url = `${apiUrl}/api/webhook/deploy/${encodeURIComponent(projectId)}`;
  const response = await requestWithRateLimitRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-regress-signature": sign(REQUEST_BODY, secret),
    },
    body: REQUEST_BODY,
  });
  const { text, json } = await readBody(response);

  if (!response.ok) {
    const detail = json?.error ?? text;
    throw new Error(`Regress rejected the scan request (HTTP ${response.status}): ${detail}`);
  }
  if (!json?.checkRunId) {
    throw new Error(`Regress returned an unexpected response: ${text}`);
  }
  return json;
}

async function fetchStatus({ apiUrl, projectId, checkRunId }) {
  const url = `${apiUrl}/api/webhook/deploy/${encodeURIComponent(projectId)}/status/${encodeURIComponent(checkRunId)}`;
  const response = await requestWithRateLimitRetry(url, { method: "GET" });
  const { text, json } = await readBody(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${json?.error ?? text}`);
  }
  return json;
}

async function waitForResult({ apiUrl, projectId, checkRunId, timeoutMinutes }) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let consecutiveFailures = 0;
  let lastStage = null;

  while (Date.now() < deadline) {
    try {
      const run = await fetchStatus({ apiUrl, projectId, checkRunId });
      consecutiveFailures = 0;
      if (run.status === "completed" || run.status === "failed") return run;
      const stage = run.pipelineStage ?? run.status;
      if (stage !== lastStage) {
        console.log(`Scan ${run.status}${run.pipelineStage ? ` (${run.pipelineStage})` : ""}`);
        lastStage = stage;
      }
    } catch (error) {
      consecutiveFailures++;
      console.log(`Status check failed: ${error.message}`);
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        throw new Error(`Could not read the scan status ${MAX_POLL_FAILURES} times in a row.`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`The scan did not finish within ${timeoutMinutes} minutes.`);
}

function describeRegression(run) {
  const reasons = [];
  if (run.status === "failed") reasons.push(`the scan failed${run.error ? `: ${run.error}` : ""}`);
  if (run.flowsFailed > 0) reasons.push(`${run.flowsFailed} flow(s) failed`);
  if (run.changeCount > 0) reasons.push(`${run.changeCount} change(s) found`);
  return reasons;
}

async function main() {
  const projectId = readInput("project-id");
  const secret = readInput("webhook-secret");
  const apiUrl = readInput("api-url", "https://api.regress.app").replace(/\/+$/, "");
  const shouldWait = readInput("wait-for-result", "false").toLowerCase() === "true";
  const timeoutMinutes = Number(readInput("timeout-minutes", "20"));

  if (!projectId) throw new Error("project-id is required.");
  if (!secret) throw new Error("webhook-secret is required.");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("timeout-minutes must be a positive number.");
  }

  const started = await startScan({ apiUrl, projectId, secret });
  const checkRunId = started.checkRunId;
  console.log(`${started.message}. Check run ${checkRunId}.`);
  setOutput("check-run-id", checkRunId);
  setOutput("status", started.status);

  if (!shouldWait) return;

  const run = await waitForResult({ apiUrl, projectId, checkRunId, timeoutMinutes });
  setOutput("status", run.status);
  setOutput("pages-checked", run.pagesChecked);
  setOutput("change-count", run.changeCount);
  setOutput("flows-tested", run.flowsTested);
  setOutput("flows-failed", run.flowsFailed);

  console.log(
    `Scan ${run.status}: ${run.pagesChecked}/${run.totalPages} pages checked, ` +
      `${run.changeCount} change(s), ${run.flowsPassed}/${run.flowsTested} flows passed.`,
  );

  const reasons = describeRegression(run);
  if (reasons.length > 0) {
    throw new Error(`Regression detected: ${reasons.join("; ")}.`);
  }
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
