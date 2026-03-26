import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const pageDocumentDuration = new Trend("page_document_duration");
const pageAssetBatchDuration = new Trend("page_asset_batch_duration");
const pageTotalDuration = new Trend("page_total_duration");
const pageAssetCount = new Trend("page_asset_count");
const pageAssetFailures = new Counter("page_asset_failures");

const method = (__ENV.LOAD_REQUEST_METHOD || __ENV.K6_REQUEST_METHOD || "GET").toUpperCase();
const body = __ENV.LOAD_REQUEST_BODY || __ENV.K6_REQUEST_BODY || null;
const loadMode = (__ENV.LOAD_MODE || "ramp").toLowerCase();
const includePageAssets = parseBoolean(__ENV.LOAD_INCLUDE_PAGE_ASSETS || "false");
const includePageImages = parseBoolean(__ENV.LOAD_INCLUDE_PAGE_IMAGES || "false");
const maxPageAssets = Number(__ENV.LOAD_MAX_PAGE_ASSETS || 60);
const acceptablePageP95 = Number(__ENV.LOAD_ACCEPTABLE_PAGE_P95_MS || 4000);

let headers = {};
try {
  headers = JSON.parse(__ENV.LOAD_REQUEST_HEADERS || __ENV.K6_REQUEST_HEADERS || "{}");
} catch (err) {
  throw new Error("LOAD_REQUEST_HEADERS must be valid JSON.");
}

const rate = Number(__ENV.LOAD_RATE || __ENV.K6_RATE || 5000);
const duration = __ENV.LOAD_DURATION || __ENV.K6_DURATION || "2m";
const preAllocatedVUs = Number(__ENV.LOAD_PRE_ALLOCATED_VUS || __ENV.K6_PRE_ALLOCATED_VUS || 2000);
const maxVUs = Number(__ENV.LOAD_MAX_VUS || __ENV.K6_MAX_VUS || 10000);
const requestTimeout = __ENV.LOAD_REQUEST_TIMEOUT || "15s";
const expectedStatusesRaw = __ENV.LOAD_EXPECTED_STATUS_CODES || "200,301,302,304";
const acceptableP95 = Number(__ENV.LOAD_ACCEPTABLE_P95_MS || __ENV.K6_ACCEPTABLE_P95_MS || 800);
const acceptableErrorRate = Number(__ENV.LOAD_ACCEPTABLE_ERROR_RATE || __ENV.K6_ACCEPTABLE_ERROR_RATE || 0.01);
const defaultUrl = __ENV.LOAD_TEST_URL || __ENV.K6_TEST_URL || "";
const routeUrls = parseRouteUrls(__ENV.LOAD_TEST_URLS || __ENV.K6_TEST_URLS || "", defaultUrl);
const routeWeights = parseRouteWeights(__ENV.LOAD_ROUTE_WEIGHTS || "", routeUrls.length);
const routeNames = parseRouteNames(__ENV.LOAD_ROUTE_NAMES || "", routeUrls.length);
const globalAssetHosts = parseSimpleList(__ENV.LOAD_PAGE_ASSET_HOSTS || "");
const routes = routeUrls.map((routeUrl, index) => buildRoute(routeUrl, index, routeNames[index], routeWeights[index]));

if (!routes.length) {
  throw new Error("LOAD_TEST_URL or LOAD_TEST_URLS is required. Set it in .env.");
}

if (includePageAssets && method !== "GET") {
  throw new Error("LOAD_INCLUDE_PAGE_ASSETS=true requires LOAD_REQUEST_METHOD=GET.");
}

if (!Number.isFinite(maxPageAssets) || maxPageAssets < 0) {
  throw new Error("LOAD_MAX_PAGE_ASSETS must be a non-negative number.");
}

function parseExpectedStatuses(raw) {
  const parsed = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));

  if (!parsed.length) {
    throw new Error("LOAD_EXPECTED_STATUS_CODES must include at least one HTTP status code.");
  }

  const invalid = parsed.find((status) => !Number.isInteger(status) || status < 100 || status > 599);
  if (invalid !== undefined) {
    throw new Error(`Invalid status in LOAD_EXPECTED_STATUS_CODES: "${invalid}".`);
  }

  return new Set(parsed);
}

function parseBoolean(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw || "").trim().toLowerCase());
}

function parseSimpleList(raw) {
  return String(raw || "")
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseRouteUrls(rawUrls, fallbackUrl) {
  const inputs = parseSimpleList(rawUrls);

  if (!inputs.length && fallbackUrl) {
    inputs.push(fallbackUrl);
  }

  return inputs.map((value) => {
    const parts = parseUrlParts(value);
    return `${parts.origin}${parts.path}`;
  });
}

function parseRouteWeights(rawWeights, expectedCount) {
  if (expectedCount === 0) {
    return [];
  }

  const inputs = parseSimpleList(rawWeights);
  if (!inputs.length) {
    return Array(expectedCount).fill(1);
  }

  if (inputs.length !== expectedCount) {
    throw new Error(
      `LOAD_ROUTE_WEIGHTS count (${inputs.length}) must match route count (${expectedCount}).`,
    );
  }

  return inputs.map((value, index) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid LOAD_ROUTE_WEIGHTS value at position ${index + 1}: "${value}".`);
    }

    return parsed;
  });
}

function parseRouteNames(rawNames, expectedCount) {
  if (expectedCount === 0) {
    return [];
  }

  const inputs = parseSimpleList(rawNames);
  if (!inputs.length) {
    return Array(expectedCount).fill("");
  }

  if (inputs.length !== expectedCount) {
    throw new Error(`LOAD_ROUTE_NAMES count (${inputs.length}) must match route count (${expectedCount}).`);
  }

  return inputs.map((value) => value.trim());
}

function parseStages(stageSpec) {
  if (!stageSpec || !stageSpec.trim()) {
    return [];
  }

  return stageSpec.split(",").map((item, index) => {
    const [targetRaw, durationRaw] = item.split(":").map((v) => (v || "").trim());
    if (!targetRaw || !durationRaw) {
      throw new Error(
        `Invalid LOAD_STAGES item #${index + 1}. Expected format: "<target>:<duration>", e.g. "1000:1m".`,
      );
    }

    const target = Number(targetRaw);
    if (!Number.isFinite(target) || target < 0) {
      throw new Error(`Invalid target in LOAD_STAGES item #${index + 1}: "${targetRaw}".`);
    }

    return { target, duration: durationRaw };
  });
}

function parseUrlParts(input) {
  const match = String(input || "").match(/^(https?):\/\/([^\/]+)(\/.*)?$/i);
  if (!match) {
    throw new Error(`LOAD_TEST_URL must be an absolute http/https URL. Received: "${input}".`);
  }

  const protocol = match[1].toLowerCase();
  const host = match[2];
  const path = match[3] || "/";
  const pathWithoutQuery = path.split("?")[0].split("#")[0];
  const baseDir = pathWithoutQuery.endsWith("/")
    ? pathWithoutQuery
    : pathWithoutQuery.replace(/\/[^\/]*$/, "/") || "/";

  return {
    protocol,
    host,
    origin: `${protocol}://${host}`,
    path,
    baseDir,
  };
}

function normalizePath(pathname) {
  const parts = String(pathname || "/").split("/");
  const normalized = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      if (normalized.length) {
        normalized.pop();
      }
      continue;
    }

    normalized.push(part);
  }

  return `/${normalized.join("/")}`;
}

function buildRouteLabel(urlParts, index, customName) {
  const sanitizedCustomName = String(customName || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
  if (sanitizedCustomName) {
    return sanitizedCustomName;
  }

  const cleanPath = (urlParts.path || "/")
    .split("?")[0]
    .split("#")[0]
    .replace(/^\/+|\/+$/g, "");
  const compactPath = cleanPath
    ? cleanPath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48)
    : "root";

  return `route_${String(index + 1).padStart(2, "0")}_${compactPath || "page"}`;
}

function buildAllowedAssetHosts(baseUrl) {
  const hosts = new Set([baseUrl.host]);

  for (const host of globalAssetHosts) {
    hosts.add(host);
  }

  return hosts;
}

function buildRoute(routeUrl, index, routeName, weight) {
  const urlParts = parseUrlParts(routeUrl);

  return {
    index,
    name: buildRouteLabel(urlParts, index, routeName),
    url: routeUrl,
    weight,
    urlParts,
    allowedAssetHosts: buildAllowedAssetHosts(urlParts),
  };
}

function pickRoute() {
  if (routes.length === 1) {
    return routes[0];
  }

  const totalWeight = routes.reduce((sum, route) => sum + route.weight, 0);
  const selectedWeight = Math.random() * totalWeight;
  let cumulativeWeight = 0;

  for (const route of routes) {
    cumulativeWeight += route.weight;
    if (selectedWeight < cumulativeWeight) {
      return route;
    }
  }

  return routes[routes.length - 1];
}

function getTagAttribute(tagSource, attributeName) {
  const attributePattern = new RegExp(`\\b${attributeName}\\s*=\\s*(['"])(.*?)\\1`, "i");
  const match = attributePattern.exec(tagSource);
  return match ? match[2] : null;
}

function getTagAttributeTokens(tagSource, attributeName) {
  const value = getTagAttribute(tagSource, attributeName);
  return value ? value.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

function resolveAssetUrl(candidate, route) {
  const value = String(candidate || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("javascript:")) {
    return null;
  }

  try {
    let resolvedUrl = null;

    if (/^https?:\/\//i.test(value)) {
      resolvedUrl = value;
    } else if (value.startsWith("//")) {
      resolvedUrl = `${route.urlParts.protocol}:${value}`;
    } else if (value.startsWith("/")) {
      resolvedUrl = `${route.urlParts.origin}${value}`;
    } else {
      resolvedUrl = `${route.urlParts.origin}${normalizePath(`${route.urlParts.baseDir}${value}`)}`;
    }

    const resolvedParts = parseUrlParts(resolvedUrl);
    if (!route.allowedAssetHosts.has(resolvedParts.host)) {
      return null;
    }

    return resolvedUrl;
  } catch (err) {
    return null;
  }
}

function pushAssetTarget(candidateUrl, tag, route, targets, seenUrls) {
  if (targets.length >= maxPageAssets) {
    return false;
  }

  const assetUrl = resolveAssetUrl(candidateUrl, route);
  if (!assetUrl || seenUrls.has(assetUrl)) {
    return true;
  }

  seenUrls.add(assetUrl);
  targets.push({ url: assetUrl, tag });
  return true;
}

function collectAssetMatches(html, regex, route, collectDescriptor, targets, seenUrls) {
  let match;

  while ((match = regex.exec(html)) !== null) {
    if (targets.length >= maxPageAssets) {
      return;
    }

    const descriptor = collectDescriptor(match[0]);
    if (!descriptor || !descriptor.url) {
      continue;
    }

    pushAssetTarget(descriptor.url, descriptor.tag, route, targets, seenUrls);
  }
}

function resolveLinkAsset(tagSource) {
  const relTokens = getTagAttributeTokens(tagSource, "rel");
  const href = getTagAttribute(tagSource, "href");
  if (!href || !relTokens.length) {
    return null;
  }

  if (relTokens.includes("stylesheet")) {
    return { url: href, tag: "style" };
  }

  if (relTokens.includes("modulepreload")) {
    return { url: href, tag: "script" };
  }

  if (relTokens.includes("preload")) {
    const asValue = (getTagAttribute(tagSource, "as") || "").trim().toLowerCase();
    if (asValue === "style" || asValue === "script" || asValue === "font") {
      return { url: href, tag: asValue };
    }
  }

  return null;
}

function extractAssetTargets(html, route) {
  if (!html || maxPageAssets === 0) {
    return [];
  }

  const targets = [];
  const seenUrls = new Set();

  collectAssetMatches(
    html,
    /<script\b[^>]*>/gi,
    route,
    (tagSource) => {
      const src = getTagAttribute(tagSource, "src");
      return src ? { url: src, tag: "script" } : null;
    },
    targets,
    seenUrls,
  );
  collectAssetMatches(
    html,
    /<link\b[^>]*>/gi,
    route,
    resolveLinkAsset,
    targets,
    seenUrls,
  );

  if (includePageImages) {
    collectAssetMatches(
      html,
      /<img\b[^>]*>/gi,
      route,
      (tagSource) => {
        const src = getTagAttribute(tagSource, "src");
        return src ? { url: src, tag: "image" } : null;
      },
      targets,
      seenUrls,
    );
  }

  return targets;
}

function isHtmlResponse(response) {
  const contentType = response.headers["Content-Type"] || response.headers["content-type"] || "";
  return String(contentType).toLowerCase().includes("text/html");
}

const defaultStagesSpec = "200:1m,500:1m,1000:1m,2000:1m,3500:1m,5000:1m";
const stages = parseStages(__ENV.LOAD_STAGES || defaultStagesSpec);
const startRate = Number(__ENV.LOAD_START_RATE || (stages[0] ? stages[0].target : rate));
const expectedStatuses = parseExpectedStatuses(expectedStatusesRaw);
const expectedStatusRanges = Array.from(expectedStatuses).map((status) => ({ min: status, max: status }));
const expectedStatusCallback = http.expectedStatuses.apply(http, expectedStatusRanges);

if (Number.isNaN(startRate) || startRate < 0) {
  throw new Error("LOAD_START_RATE must be a non-negative number.");
}

if (loadMode !== "constant" && loadMode !== "ramp") {
  throw new Error('LOAD_MODE must be either "ramp" or "constant".');
}

const scenario =
  loadMode === "constant"
    ? {
        executor: "constant-arrival-rate",
        rate: rate,
        timeUnit: "1s",
        duration: duration,
        preAllocatedVUs: preAllocatedVUs,
        maxVUs: maxVUs,
        gracefulStop: "0s",
      }
    : {
        executor: "ramping-arrival-rate",
        startRate: startRate,
        timeUnit: "1s",
        stages: stages,
        preAllocatedVUs: preAllocatedVUs,
        maxVUs: maxVUs,
        gracefulStop: "0s",
      };

const thresholds = {
  http_req_failed: [`rate<${acceptableErrorRate}`],
  http_req_duration: [`p(95)<${acceptableP95}`],
};

if (includePageAssets) {
  thresholds.page_asset_failures = ["count==0"];
  thresholds.page_total_duration = [`p(95)<${acceptablePageP95}`];
}

export const options = {
  discardResponseBodies: !includePageAssets,
  scenarios: {
    frontend_load: scenario,
  },
  thresholds,
};

function sendRequest(route, extraTags = {}) {
  const tags = {
    route: route.name,
    page_kind: "document",
  };

  for (const [key, value] of Object.entries(extraTags)) {
    tags[key] = value;
  }

  const params = {
    headers,
    timeout: requestTimeout,
    responseCallback: expectedStatusCallback,
    tags,
  };

  return (
    method === "GET"
      ? http.get(route.url, params)
      : http.request(method, route.url, body, params)
  );
}

function isExpectedStatus(status) {
  return expectedStatuses.has(status);
}

function fetchDocumentWithAssets(route) {
  const response = sendRequest(route);
  const documentDuration =
    response.timings && typeof response.timings.duration === "number" ? response.timings.duration : 0;

  pageDocumentDuration.add(documentDuration, { route: route.name });

  if (!response.body || !isHtmlResponse(response)) {
    pageAssetCount.add(0, { route: route.name });
    pageTotalDuration.add(documentDuration, { route: route.name });
    return { response, assetCount: 0, failedAssetCount: 0 };
  }

  const assetTargets = extractAssetTargets(response.body, route);
  pageAssetCount.add(assetTargets.length, { route: route.name });

  if (!assetTargets.length) {
    pageTotalDuration.add(documentDuration, { route: route.name });
    return { response, assetCount: 0, failedAssetCount: 0 };
  }

  const assetRequests = assetTargets.map((asset) => ({
    method: "GET",
    url: asset.url,
    params: {
      headers,
      timeout: requestTimeout,
      responseCallback: expectedStatusCallback,
      responseType: "none",
      tags: {
        route: route.name,
        page_kind: "asset",
        asset_tag: asset.tag,
      },
    },
  }));

  const assetBatchStartedAt = Date.now();
  const assetResponses = http.batch(assetRequests);
  const assetBatchWallTime = Date.now() - assetBatchStartedAt;
  let failedAssetCount = 0;

  for (const assetResponse of assetResponses) {
    if (assetResponse.error || !isExpectedStatus(assetResponse.status)) {
      failedAssetCount += 1;
    }
  }

  pageAssetBatchDuration.add(assetBatchWallTime, { route: route.name });
  pageTotalDuration.add(documentDuration + assetBatchWallTime, { route: route.name });

  if (failedAssetCount > 0) {
    pageAssetFailures.add(failedAssetCount, { route: route.name });
  }

  return {
    response,
    assetCount: assetTargets.length,
    failedAssetCount,
  };
}

export function setup() {
  const failures = [];

  for (const route of routes) {
    const response = sendRequest(route, { preflight: "true" });
    const status = typeof response.status === "number" ? response.status : 0;
    const transportError = response.error || "";

    if (transportError || !isExpectedStatus(status)) {
      failures.push(
        `${route.name} (${route.url}) status=${status}, transport_error="${transportError || "none"}"`,
      );
    }
  }

  if (failures.length) {
    throw new Error(
      `Preflight failed for ${failures.length} route(s): ${failures.join("; ")}. ` +
        `Fix LOAD_TEST_URL/LOAD_TEST_URLS/headers or adjust LOAD_EXPECTED_STATUS_CODES.`,
    );
  }
}

export default function () {
  const route = pickRoute();
  const pageLoadResult = includePageAssets
    ? fetchDocumentWithAssets(route)
    : { response: sendRequest(route), failedAssetCount: 0 };
  const response = pageLoadResult.response;

  check(response, {
    "no transport error": (r) => !r.error,
    "status is expected": (r) => isExpectedStatus(r.status),
    "page assets are healthy": () => pageLoadResult.failedAssetCount === 0,
  });
}
