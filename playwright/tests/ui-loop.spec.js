const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const pageUrl = process.env.PAGE_URL;
const loopCount = Number(process.env.LOOP_COUNT || 20);
const loopDelayMs = Number(process.env.LOOP_DELAY_MS || 1000);
const settleMs = Number(process.env.FRONTEND_SETTLE_MS || 1500);
const routeDelayMs = Number(process.env.FRONTEND_ROUTE_DELAY_MS || 0);
const captureEveryN = Number(process.env.PLAYWRIGHT_CAPTURE_EVERY_N || 5);
const defaultArtifactsDir = fs.existsSync(path.resolve(process.cwd(), "..", "artifacts"))
  ? path.resolve(process.cwd(), "..", "artifacts")
  : path.resolve(process.cwd(), "artifacts");
const artifactsDir = process.env.ARTIFACTS_DIR || defaultArtifactsDir;
const summaryDir = path.join(artifactsDir, "frontend-performance");
const checkpointDir = path.join(summaryDir, "checkpoints");

const thresholds = {
  ttfb: Number(process.env.FRONTEND_MAX_TTFB_MS || 800),
  fcp: Number(process.env.FRONTEND_MAX_FCP_MS || 1800),
  lcp: Number(process.env.FRONTEND_MAX_LCP_MS || 2500),
  load: Number(process.env.FRONTEND_MAX_LOAD_MS || 5000),
  cls: Number(process.env.FRONTEND_MAX_CLS || 0.1),
  totalBlockingTime: Number(process.env.FRONTEND_MAX_TOTAL_BLOCKING_TIME_MS || 200),
  failedRequests: Number(process.env.FRONTEND_MAX_FAILED_REQUESTS || 0),
  httpErrors: Number(process.env.FRONTEND_MAX_HTTP_ERRORS || 0),
  pageErrors: Number(process.env.FRONTEND_MAX_PAGE_ERRORS || 0),
};

function parsePageUrls(rawUrls, fallbackUrl) {
  const inputs = String(rawUrls || "")
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (!inputs.length) {
    if (!fallbackUrl) {
      return [];
    }

    inputs.push(fallbackUrl);
  }

  const baseUrl = fallbackUrl || inputs[0];

  return inputs.map((value) => {
    try {
      return new URL(value, baseUrl).toString();
    } catch (error) {
      throw new Error(`Invalid PAGE_URL/PAGE_URLS value: "${value}".`);
    }
  });
}

const pageUrls = parsePageUrls(process.env.PAGE_URLS || "", pageUrl);

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) {
    return null;
  }

  const index = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  const weight = index - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function buildStats(samples, key, digits = 2) {
  const values = samples
    .map((sample) => sample[key])
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!values.length) {
    return null;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const sum = values.reduce((accumulator, value) => accumulator + value, 0);

  return {
    count: values.length,
    min: round(sortedValues[0], digits),
    avg: round(sum / values.length, digits),
    p50: round(percentile(sortedValues, 0.5), digits),
    p95: round(percentile(sortedValues, 0.95), digits),
    max: round(sortedValues[sortedValues.length - 1], digits),
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 ? 0 : 1;
  return `${round(value, digits)} ${units[unitIndex]}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldCaptureCheckpoint(position, totalPositions) {
  if (captureEveryN <= 0) {
    return false;
  }

  return position === 1 || position === totalPositions || position % captureEveryN === 0;
}

function createMetricSummary(samples) {
  return {
    ttfb: buildStats(samples, "ttfb"),
    domContentLoaded: buildStats(samples, "domContentLoaded"),
    load: buildStats(samples, "load"),
    fcp: buildStats(samples, "fcp"),
    lcp: buildStats(samples, "lcp"),
    cls: buildStats(samples, "cls", 3),
    totalBlockingTime: buildStats(samples, "totalBlockingTime"),
    longTaskCount: buildStats(samples, "longTaskCount"),
    resourceCount: buildStats(samples, "resourceCount"),
    transferSize: buildStats(samples, "transferSize"),
    decodedBodySize: buildStats(samples, "decodedBodySize"),
  };
}

function createIssueTotals(samples) {
  return samples.reduce(
    (totals, sample) => ({
      consoleErrors: totals.consoleErrors + (sample.consoleErrors || 0),
      pageErrors: totals.pageErrors + (sample.pageErrors || 0),
      requestFailures: totals.requestFailures + (sample.requestFailures || 0),
      httpErrors: totals.httpErrors + (sample.httpErrors || 0),
    }),
    {
      consoleErrors: 0,
      pageErrors: 0,
      requestFailures: 0,
      httpErrors: 0,
    },
  );
}

function createThresholdViolations(metrics, issueTotals, scopeLabel = "") {
  const violations = [];
  const metricThresholds = [
    ["ttfb", thresholds.ttfb, "ms"],
    ["fcp", thresholds.fcp, "ms"],
    ["lcp", thresholds.lcp, "ms"],
    ["load", thresholds.load, "ms"],
    ["totalBlockingTime", thresholds.totalBlockingTime, "ms"],
    ["cls", thresholds.cls, ""],
  ];

  for (const [metricKey, limit, unit] of metricThresholds) {
    const metric = metrics[metricKey];
    if (metric && metric.p95 > limit) {
      violations.push(`${scopeLabel}${metricKey} p95 ${metric.p95}${unit} > ${limit}${unit}`);
    }
  }

  if (issueTotals.requestFailures > thresholds.failedRequests) {
    violations.push(
      `${scopeLabel}request failures ${issueTotals.requestFailures} > ${thresholds.failedRequests}`,
    );
  }

  if (issueTotals.httpErrors > thresholds.httpErrors) {
    violations.push(`${scopeLabel}http errors ${issueTotals.httpErrors} > ${thresholds.httpErrors}`);
  }

  if (issueTotals.pageErrors > thresholds.pageErrors) {
    violations.push(`${scopeLabel}page errors ${issueTotals.pageErrors} > ${thresholds.pageErrors}`);
  }

  return violations;
}

function createInventoryBucket(domain) {
  return {
    domain,
    count: 0,
    transferSize: 0,
    decodedBodySize: 0,
    initiatorCounts: {},
    scriptUrls: [],
  };
}

function mergeInventoryEntries(samples, key) {
  const buckets = new Map();

  for (const sample of samples) {
    for (const entry of sample[key] || []) {
      let bucket = buckets.get(entry.domain);
      if (!bucket) {
        bucket = createInventoryBucket(entry.domain);
        buckets.set(entry.domain, bucket);
      }

      bucket.count += entry.count || 0;
      bucket.transferSize += entry.transferSize || 0;
      bucket.decodedBodySize += entry.decodedBodySize || 0;

      for (const [initiatorType, count] of Object.entries(entry.initiatorCounts || {})) {
        bucket.initiatorCounts[initiatorType] = (bucket.initiatorCounts[initiatorType] || 0) + count;
      }

      for (const url of entry.scriptUrls || []) {
        if (!bucket.scriptUrls.includes(url) && bucket.scriptUrls.length < 20) {
          bucket.scriptUrls.push(url);
        }
      }
    }
  }

  return Array.from(buckets.values())
    .map((entry) => ({
      ...entry,
      transferSize: round(entry.transferSize, 2),
      decodedBodySize: round(entry.decodedBodySize, 2),
      scriptUrls: entry.scriptUrls.slice(0, 10),
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return right.transferSize - left.transferSize;
    });
}

function createNetworkInventory(samples) {
  return {
    requestDomains: mergeInventoryEntries(samples, "resourceDomains"),
    scriptDomains: mergeInventoryEntries(samples, "scriptDomains"),
  };
}

function formatInventoryLine(entry) {
  const scripts = entry.initiatorCounts.script || 0;
  return `- ${entry.domain}: requests ${entry.count}, scripts ${scripts}, transfer ${formatBytes(entry.transferSize)}`;
}

function buildMarkdownSummary(summary) {
  const lines = [
    "# Frontend Performance Summary",
    "",
    `- URLs: ${summary.pageUrls.length}`,
    `- Iterations: ${summary.loopCount}`,
    `- Total page views: ${summary.pageViewCount}`,
    `- Loop delay: ${summary.loopDelayMs} ms`,
    `- Route delay: ${summary.routeDelayMs} ms`,
    `- Settle wait: ${summary.settleMs} ms`,
    `- Generated at: ${summary.generatedAt}`,
    "",
    "## Routes",
  ];

  for (const routeUrl of summary.pageUrls) {
    lines.push(`- ${routeUrl}`);
  }

  lines.push("");
  lines.push("## Overall p95 metrics");

  const metricLabels = {
    ttfb: "TTFB",
    fcp: "FCP",
    lcp: "LCP",
    load: "Load",
    cls: "CLS",
    totalBlockingTime: "Total blocking time",
  };

  for (const [key, label] of Object.entries(metricLabels)) {
    const metric = summary.metrics[key];
    if (!metric) {
      continue;
    }

    const suffix = key === "cls" ? "" : " ms";
    lines.push(`- ${label}: p95 ${metric.p95}${suffix}, avg ${metric.avg}${suffix}`);
  }

  lines.push("");
  lines.push("## Route Summary");

  for (const routeSummary of summary.routeSummaries) {
    const ttfbMetric = routeSummary.metrics.ttfb;
    const lcpMetric = routeSummary.metrics.lcp;
    const loadMetric = routeSummary.metrics.load;
    lines.push(
      `- ${routeSummary.routeUrl}: samples ${routeSummary.sampleCount}, TTFB p95 ${ttfbMetric ? `${ttfbMetric.p95} ms` : "n/a"}, LCP p95 ${lcpMetric ? `${lcpMetric.p95} ms` : "n/a"}, Load p95 ${loadMetric ? `${loadMetric.p95} ms` : "n/a"}`,
    );
  }

  lines.push("");
  lines.push("## First vs Repeat");

  const firstLoad = summary.phases.firstIteration.metrics.load;
  const repeatLoad = summary.phases.repeatIterations.metrics.load;
  lines.push(
    `- First iteration load p95: ${firstLoad ? `${firstLoad.p95} ms` : "n/a"}`,
  );
  lines.push(
    `- Repeat iteration load p95: ${repeatLoad ? `${repeatLoad.p95} ms` : "n/a"}`,
  );

  lines.push("");
  lines.push("## Request health");
  lines.push(`- Request failures: ${summary.issueTotals.requestFailures}`);
  lines.push(`- HTTP errors: ${summary.issueTotals.httpErrors}`);
  lines.push(`- Page errors: ${summary.issueTotals.pageErrors}`);
  lines.push(`- Console errors: ${summary.issueTotals.consoleErrors}`);
  lines.push("");
  lines.push("## Page footprint");
  lines.push(`- Avg resources: ${summary.metrics.resourceCount ? summary.metrics.resourceCount.avg : 0}`);
  lines.push(
    `- Avg transfer size: ${summary.metrics.transferSize ? formatBytes(summary.metrics.transferSize.avg) : "0 B"}`,
  );

  if (summary.networkInventory.requestDomains.length) {
    lines.push("");
    lines.push("## Request Domain Inventory");
    for (const entry of summary.networkInventory.requestDomains.slice(0, 10)) {
      lines.push(formatInventoryLine(entry));
    }
  }

  if (summary.networkInventory.scriptDomains.length) {
    lines.push("");
    lines.push("## Script Domain Inventory");
    for (const entry of summary.networkInventory.scriptDomains.slice(0, 10)) {
      lines.push(formatInventoryLine(entry));
      for (const scriptUrl of entry.scriptUrls.slice(0, 5)) {
        lines.push(`  JS: ${scriptUrl}`);
      }
    }
  }

  for (const routeSummary of summary.routeSummaries) {
    if (!routeSummary.networkInventory.scriptDomains.length) {
      continue;
    }

    lines.push("");
    lines.push(`## Route Script Inventory: ${routeSummary.routeUrl}`);
    for (const entry of routeSummary.networkInventory.scriptDomains.slice(0, 5)) {
      lines.push(formatInventoryLine(entry));
      for (const scriptUrl of entry.scriptUrls.slice(0, 5)) {
        lines.push(`  JS: ${scriptUrl}`);
      }
    }
  }

  if (summary.violations.length) {
    lines.push("");
    lines.push("## Threshold violations");
    for (const violation of summary.violations) {
      lines.push(`- ${violation}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function installPerformanceObservers(page) {
  await page.addInitScript(() => {
    window.__frontendPerf = {
      cls: 0,
      lcp: null,
      fcp: null,
      longTaskCount: 0,
      totalBlockingTime: 0,
      observerErrors: [],
    };

    const supportedTypes =
      typeof PerformanceObserver !== "undefined" && Array.isArray(PerformanceObserver.supportedEntryTypes)
        ? PerformanceObserver.supportedEntryTypes
        : [];

    const observe = (type, handler) => {
      if (!supportedTypes.includes(type)) {
        return;
      }

      try {
        const observer = new PerformanceObserver((list) => {
          handler(list.getEntries());
        });
        observer.observe({ type, buffered: true });
      } catch (error) {
        window.__frontendPerf.observerErrors.push(`${type}: ${error.message}`);
      }
    };

    observe("paint", (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint") {
          window.__frontendPerf.fcp = entry.startTime;
        }
      }
    });

    observe("largest-contentful-paint", (entries) => {
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        window.__frontendPerf.lcp = lastEntry.startTime;
      }
    });

    observe("layout-shift", (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput) {
          window.__frontendPerf.cls += entry.value;
        }
      }
    });

    observe("longtask", (entries) => {
      for (const entry of entries) {
        window.__frontendPerf.longTaskCount += 1;
        window.__frontendPerf.totalBlockingTime += Math.max(0, entry.duration - 50);
      }
    });
  });
}

async function collectPageMetrics(page) {
  return await page.evaluate(() => {
    const navigationEntry = performance.getEntriesByType("navigation")[0];
    const resourceEntries = performance.getEntriesByType("resource");
    const initiatorCounts = {};
    const resourceDomains = {};
    const scriptDomains = {};
    let transferSize = 0;
    let decodedBodySize = 0;

    const ensureBucket = (collection, domain) => {
      if (!collection[domain]) {
        collection[domain] = {
          domain,
          count: 0,
          transferSize: 0,
          decodedBodySize: 0,
          initiatorCounts: {},
          scriptUrls: [],
        };
      }

      return collection[domain];
    };

    const isScriptResource = (entryUrl, initiatorType) => {
      if (initiatorType === "script") {
        return true;
      }

      try {
        return /\.(m?js)(?:$|[?#])/i.test(new URL(entryUrl).pathname);
      } catch (error) {
        return false;
      }
    };

    for (const entry of resourceEntries) {
      const type = entry.initiatorType || "other";
      let domain = "invalid";
      try {
        domain = new URL(entry.name).host || "same-origin";
      } catch (error) {
        domain = "invalid";
      }

      initiatorCounts[type] = (initiatorCounts[type] || 0) + 1;
      transferSize += entry.transferSize || 0;
      decodedBodySize += entry.decodedBodySize || 0;

      const resourceBucket = ensureBucket(resourceDomains, domain);
      resourceBucket.count += 1;
      resourceBucket.transferSize += entry.transferSize || 0;
      resourceBucket.decodedBodySize += entry.decodedBodySize || 0;
      resourceBucket.initiatorCounts[type] = (resourceBucket.initiatorCounts[type] || 0) + 1;

      if (isScriptResource(entry.name, type)) {
        const scriptBucket = ensureBucket(scriptDomains, domain);
        scriptBucket.count += 1;
        scriptBucket.transferSize += entry.transferSize || 0;
        scriptBucket.decodedBodySize += entry.decodedBodySize || 0;
        scriptBucket.initiatorCounts[type] = (scriptBucket.initiatorCounts[type] || 0) + 1;
        if (!scriptBucket.scriptUrls.includes(entry.name) && scriptBucket.scriptUrls.length < 20) {
          scriptBucket.scriptUrls.push(entry.name);
        }
      }
    }

    return {
      title: document.title,
      url: window.location.href,
      ttfb: navigationEntry ? navigationEntry.responseStart : null,
      domContentLoaded: navigationEntry ? navigationEntry.domContentLoadedEventEnd : null,
      load: navigationEntry ? navigationEntry.loadEventEnd : null,
      transferSize: transferSize + (navigationEntry ? navigationEntry.transferSize || 0 : 0),
      decodedBodySize: decodedBodySize + (navigationEntry ? navigationEntry.decodedBodySize || 0 : 0),
      resourceCount: resourceEntries.length,
      initiatorCounts,
      resourceDomains: Object.values(resourceDomains).sort((left, right) => right.count - left.count),
      scriptDomains: Object.values(scriptDomains).sort((left, right) => right.count - left.count),
      observerErrors: (window.__frontendPerf && window.__frontendPerf.observerErrors) || [],
      fcp: window.__frontendPerf ? window.__frontendPerf.fcp : null,
      lcp: window.__frontendPerf ? window.__frontendPerf.lcp : null,
      cls: window.__frontendPerf ? window.__frontendPerf.cls : null,
      longTaskCount: window.__frontendPerf ? window.__frontendPerf.longTaskCount : null,
      totalBlockingTime: window.__frontendPerf ? window.__frontendPerf.totalBlockingTime : null,
    };
  });
}

test("frontend loop with performance summary", async ({ page }, testInfo) => {
  if (!pageUrl && !pageUrls.length) {
    throw new Error("PAGE_URL is required. Set it in .env.");
  }

  fs.mkdirSync(summaryDir, { recursive: true });
  fs.mkdirSync(checkpointDir, { recursive: true });

  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  const samples = [];
  const checkpoints = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({ text: message.text(), ts: Date.now() });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push({ message: error.message, ts: Date.now() });
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure() ? request.failure().errorText : "unknown",
      ts: Date.now(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push({
        url: response.url(),
        status: response.status(),
        resourceType: response.request().resourceType(),
        ts: Date.now(),
      });
    }
  });

  await installPerformanceObservers(page);

  const totalPageViews = loopCount * pageUrls.length;

  for (let iteration = 1; iteration <= loopCount; iteration += 1) {
    if (iteration > 1) {
      await page.waitForTimeout(loopDelayMs);
    }

    for (let routeIndex = 0; routeIndex < pageUrls.length; routeIndex += 1) {
      const countsBefore = {
        consoleErrors: consoleErrors.length,
        pageErrors: pageErrors.length,
        requestFailures: requestFailures.length,
        httpErrors: httpErrors.length,
      };
      const routeUrl = pageUrls[routeIndex];

      await page.goto(routeUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(settleMs);
      await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(routeUrl)}`));

      const metrics = await collectPageMetrics(page);
      const sample = {
        iteration,
        routeIndex: routeIndex + 1,
        routeUrl,
        ...metrics,
        consoleErrors: consoleErrors.length - countsBefore.consoleErrors,
        pageErrors: pageErrors.length - countsBefore.pageErrors,
        requestFailures: requestFailures.length - countsBefore.requestFailures,
        httpErrors: httpErrors.length - countsBefore.httpErrors,
      };

      samples.push(sample);

      const samplePosition = samples.length;
      if (shouldCaptureCheckpoint(samplePosition, totalPageViews)) {
        const checkpointPath = path.join(
          checkpointDir,
          `view-${String(samplePosition).padStart(3, "0")}-iter-${String(iteration).padStart(2, "0")}-route-${String(routeIndex + 1).padStart(2, "0")}.png`,
        );
        await page.screenshot({
          path: checkpointPath,
          fullPage: true,
        });
        checkpoints.push(checkpointPath);
      }

      if (routeDelayMs > 0 && routeIndex < pageUrls.length - 1) {
        await page.waitForTimeout(routeDelayMs);
      }
    }
  }

  const metrics = createMetricSummary(samples);
  const issueTotals = createIssueTotals(samples);
  const routeSummaries = pageUrls.map((routeUrl) => {
    const routeSamples = samples.filter((sample) => sample.routeUrl === routeUrl);
    const routeMetrics = createMetricSummary(routeSamples);
    const routeIssueTotals = createIssueTotals(routeSamples);

    return {
      routeUrl,
      sampleCount: routeSamples.length,
      metrics: routeMetrics,
      issueTotals: routeIssueTotals,
      networkInventory: createNetworkInventory(routeSamples),
      violations: createThresholdViolations(routeMetrics, routeIssueTotals, `${routeUrl}: `),
    };
  });
  const firstIterationSamples = samples.filter((sample) => sample.iteration === 1);
  const repeatIterationSamples = samples.filter((sample) => sample.iteration > 1);

  const summary = {
    generatedAt: new Date().toISOString(),
    pageUrl: pageUrls[0],
    pageUrls,
    loopCount,
    pageViewCount: totalPageViews,
    loopDelayMs,
    routeDelayMs,
    settleMs,
    thresholds,
    metrics,
    issueTotals,
    networkInventory: createNetworkInventory(samples),
    routeSummaries,
    phases: {
      firstIteration: {
        sampleCount: firstIterationSamples.length,
        metrics: createMetricSummary(firstIterationSamples),
        issueTotals: createIssueTotals(firstIterationSamples),
      },
      repeatIterations: {
        sampleCount: repeatIterationSamples.length,
        metrics: createMetricSummary(repeatIterationSamples),
        issueTotals: createIssueTotals(repeatIterationSamples),
      },
    },
    issueSamples: {
      consoleErrors: consoleErrors.slice(0, 20),
      pageErrors: pageErrors.slice(0, 20),
      requestFailures: requestFailures.slice(0, 20),
      httpErrors: httpErrors.slice(0, 20),
    },
    checkpoints,
    samples,
  };

  summary.violations = [
    ...createThresholdViolations(summary.metrics, summary.issueTotals),
    ...routeSummaries.flatMap((routeSummary) => routeSummary.violations),
  ];

  const jsonSummaryPath = path.join(summaryDir, "summary.json");
  const markdownSummaryPath = path.join(summaryDir, "summary.md");
  fs.writeFileSync(jsonSummaryPath, JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(markdownSummaryPath, buildMarkdownSummary(summary), "utf8");

  await testInfo.attach("frontend-performance-summary", {
    path: jsonSummaryPath,
    contentType: "application/json",
  });

  expect(
    summary.violations,
    `Frontend performance thresholds failed. See ${markdownSummaryPath}`,
  ).toEqual([]);
});
