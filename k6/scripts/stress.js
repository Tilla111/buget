import http from "k6/http";
import { check } from "k6";

const url = __ENV.LOAD_TEST_URL || __ENV.K6_TEST_URL;
if (!url) {
  throw new Error("LOAD_TEST_URL is required. Set it in .env.");
}

const method = (__ENV.LOAD_REQUEST_METHOD || __ENV.K6_REQUEST_METHOD || "GET").toUpperCase();
const body = __ENV.LOAD_REQUEST_BODY || __ENV.K6_REQUEST_BODY || null;
const loadMode = (__ENV.LOAD_MODE || "ramp").toLowerCase();

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

const defaultStagesSpec = "1000:1m,2000:1m,3000:1m,4000:1m,5000:1m,5000:1m";
const stages = parseStages(__ENV.LOAD_STAGES || defaultStagesSpec);
const startRate = Number(__ENV.LOAD_START_RATE || (stages[0] ? stages[0].target : rate));
const expectedStatuses = parseExpectedStatuses(expectedStatusesRaw);
const expectedStatusRanges = Array.from(expectedStatuses).map((status) => ({ min: status, max: status }));
const expectedStatusCallback = http.expectedStatuses(...expectedStatusRanges);

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

export const options = {
  discardResponseBodies: true,
  scenarios: {
    stress_5k_rps: scenario,
  },
  thresholds: {
    http_req_failed: [`rate<${acceptableErrorRate}`],
    http_req_duration: [`p(95)<${acceptableP95}`],
  },
};

function sendRequest() {
  const params = {
    headers,
    timeout: requestTimeout,
    responseCallback: expectedStatusCallback,
  };

  return (
    method === "GET"
      ? http.get(url, params)
      : http.request(method, url, body, params)
  );
}

function isExpectedStatus(status) {
  return expectedStatuses.has(status);
}

export function setup() {
  const response = sendRequest();
  const status = typeof response.status === "number" ? response.status : 0;
  const transportError = response.error || "";

  if (transportError || !isExpectedStatus(status)) {
    throw new Error(
      `Preflight failed for ${url}. status=${status}, transport_error="${transportError || "none"}". ` +
        `Fix LOAD_TEST_URL/headers or adjust LOAD_EXPECTED_STATUS_CODES.`,
    );
  }
}

export default function () {
  const response = sendRequest();

  check(response, {
    "no transport error": (r) => !r.error,
    "status is expected": (r) => isExpectedStatus(r.status),
  });
}
