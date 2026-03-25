const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://average-price.imv.uz';
const PRODUCT_CODE = '19.20.21.100-00001';
const OUT_DIR = path.resolve(__dirname, '../artifacts');

function normalizeText(v) {
  if (v == null) return '';
  return String(v).replace(/\u00A0/g, ' ').trim();
}

function parseUiNumber(input) {
  const raw = normalizeText(input);
  if (!raw || raw === '-' || raw === '—') return null;

  let s = raw.toLowerCase();
  let multiplier = 1;
  if (s.includes('млрд')) multiplier = 1_000_000_000;
  else if (s.includes('млн')) multiplier = 1_000_000;
  else if (s.includes('тыс')) multiplier = 1_000;

  s = s.replace(/[^0-9,.-]/g, '');
  if (!s) return null;
  s = s.replace(/,/g, '.');
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return n * multiplier;
}

function near(a, b, absTol = 1, relTol = 0.001) {
  if (a == null || b == null) return false;
  const d = Math.abs(a - b);
  return d <= absTol || d <= Math.abs(b) * relTol;
}

function roundN(v, n = 2) {
  return Number(v.toFixed(n));
}

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`POST ${url} failed: ${r.status}`);
  return await r.json();
}

function computeOutlierSums(prices, avgPrice) {
  let over = 0;
  let under = 0;
  let aboveCount = 0;
  let belowCount = 0;

  for (const p of prices) {
    const price = Number(p.price);
    const qty = Number(p.quantity || 0);
    if (price > avgPrice * 1.1) {
      over += price * qty;
      aboveCount += 1;
    } else if (price < avgPrice * 0.8) {
      under += price * qty;
      belowCount += 1;
    }
  }

  return {
    over,
    under,
    total: over + under,
    aboveCount,
    belowCount,
    normalCount: prices.length - aboveCount - belowCount,
  };
}

function buildOutlierCounter(outliers) {
  const map = new Map();
  for (const o of outliers) {
    const key = `${o.date}|${Number(o.price)}|${Number(o.quantity)}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function removeOutliers(prices, outliers) {
  const counter = buildOutlierCounter(outliers);
  const filtered = [];
  for (const p of prices) {
    const key = `${p.date}|${Number(p.price)}|${Number(p.quantity)}`;
    const c = counter.get(key) || 0;
    if (c > 0) {
      counter.set(key, c - 1);
    } else {
      filtered.push(p);
    }
  }
  return filtered;
}

function computeAiAdjustedMetrics(avgData, removedOutliers) {
  const filtered = removeOutliers(avgData.prices, removedOutliers);
  const count = filtered.length;
  const min = Math.min(...filtered.map((x) => Number(x.price)));
  const max = Math.max(...filtered.map((x) => Number(x.price)));

  const totalQty = filtered.reduce((s, x) => s + Number(x.quantity || 0), 0);
  const weightedAvg =
    filtered.reduce((s, x) => s + Number(x.price) * Number(x.quantity || 0), 0) / totalQty;
  const avgRounded = Math.trunc(weightedAvg);

  const variance =
    filtered.reduce((s, x) => {
      const d = Number(x.price) - avgRounded;
      return s + d * d;
    }, 0) / count;
  const std = Math.sqrt(variance);
  const coeff = (std / avgRounded) * 100;

  const outlierSums = computeOutlierSums(filtered, avgRounded);

  let aiUp = 0;
  let aiDown = 0;
  for (const o of removedOutliers) {
    const value = Number(o.price) * Number(o.quantity || 0);
    if (Number(o.price) > avgRounded * 1.1) aiUp += value;
    if (Number(o.price) < avgRounded * 0.8) aiDown += value;
  }

  return {
    min,
    avg: avgRounded,
    max,
    count,
    std,
    coeff,
    over: outlierSums.over,
    under: outlierSums.under,
    total: outlierSums.total,
    aiUp,
    aiDown,
    weightedAvgRaw: weightedAvg,
  };
}

async function captureUiState(page) {
  return await page.evaluate(() => {
    const card = (cls) =>
      document.querySelector(`${cls} .stat-card__value`)?.textContent?.trim() || null;

    const specs = Array.from(document.querySelectorAll('select.spec-select')).map((s, i) => ({
      index: i,
      value: s.value,
      selectedText: s.options[s.selectedIndex]?.text || null,
      options: Array.from(s.options).map((o) => ({ value: o.value, text: o.textContent.trim() })),
    }));

    const charts = { price: null, volume: null };
    if (window.Chart) {
      const p = Chart.getChart(document.getElementById('priceChart'));
      const v = Chart.getChart(document.getElementById('volumeChart'));
      if (p) {
        charts.price = {
          datasets: (p.data.datasets || []).map((d) => ({
            label: d.label || null,
            count: Array.isArray(d.data) ? d.data.length : null,
          })),
        };
      }
      if (v) {
        const ds = (v.data.datasets || [])[0];
        const values = Array.isArray(ds?.data) ? ds.data.map((x) => Number(x || 0)) : [];
        charts.volume = {
          labelsCount: Array.isArray(v.data.labels) ? v.data.labels.length : 0,
          barCount: values.length,
          barSum: values.reduce((a, b) => a + b, 0),
        };
      }
    }

    const bodyText = document.body?.innerText || '';

    return {
      cards: {
        min: card('.stat-card--min'),
        avg: card('.stat-card--avg'),
        max: card('.stat-card--max'),
        count: card('.stat-card--count'),
        stddev: card('.stat-card--stddev'),
        coeff: card('.stat-card--coeff'),
        over: card('.stat-card--overprice'),
        under: card('.stat-card--underprice'),
        aiUp: card('.stat-card--ai-up'),
        aiDown: card('.stat-card--ai-down'),
        total: card('.stat-card--total-outlier'),
      },
      specs,
      aiChecked: document.querySelector('#ai-outliers-ai-cb')?.checked || false,
      charts,
      localizationMarkers: {
        hasRu: bodyText.includes('РЕЗУЛЬТАТЫ') || bodyText.includes('ШАГ 2'),
        hasEn: bodyText.includes('Unit') || bodyText.includes('Ecological class'),
        hasUz: bodyText.includes('ЎРТАЧА') || bodyText.includes('НАРХЛАРНИНГ'),
      },
    };
  });
}

function mapUiCardNumbers(cards) {
  return {
    min: parseUiNumber(cards.min),
    avg: parseUiNumber(cards.avg),
    max: parseUiNumber(cards.max),
    count: parseUiNumber(cards.count),
    std: parseUiNumber(cards.stddev),
    coeff: parseUiNumber(cards.coeff),
    over: parseUiNumber(cards.over),
    under: parseUiNumber(cards.under),
    aiUp: parseUiNumber(cards.aiUp),
    aiDown: parseUiNumber(cards.aiDown),
    total: parseUiNumber(cards.total),
  };
}

function assessState(name, uiNums, expected, chartInfo, distTotal, distBinsLen) {
  const checks = [];

  checks.push({ name: `${name}: min`, pass: near(uiNums.min, expected.min, 2, 0.0001), ui: uiNums.min, exp: expected.min });
  checks.push({ name: `${name}: avg`, pass: near(uiNums.avg, expected.avg, 2, 0.0002), ui: uiNums.avg, exp: expected.avg });
  checks.push({ name: `${name}: max`, pass: near(uiNums.max, expected.max, 2, 0.0001), ui: uiNums.max, exp: expected.max });
  checks.push({ name: `${name}: count`, pass: near(uiNums.count, expected.count, 0, 0), ui: uiNums.count, exp: expected.count });
  checks.push({ name: `${name}: stddev`, pass: near(uiNums.std, expected.std, 5000, 0.01), ui: uiNums.std, exp: expected.std });
  checks.push({ name: `${name}: coeff`, pass: near(uiNums.coeff, expected.coeff, 2, 0.01), ui: uiNums.coeff, exp: expected.coeff });
  checks.push({ name: `${name}: over sum`, pass: near(uiNums.over, expected.over, 15_000_000, 0.015), ui: uiNums.over, exp: expected.over });
  checks.push({ name: `${name}: under sum`, pass: near(uiNums.under, expected.under, 15_000_000, 0.015), ui: uiNums.under, exp: expected.under });
  checks.push({ name: `${name}: total sum`, pass: near(uiNums.total, expected.total, 15_000_000, 0.015), ui: uiNums.total, exp: expected.total });

  const priceDatasets = chartInfo?.price?.datasets || [];
  const findDs = (k) => priceDatasets.find((d) => (d.label || '').toLowerCase().includes(k));
  const normal = findDs('цена сделки');
  const above = findDs('выше средней');
  const below = findDs('ниже средней');

  if (normal && above && below) {
    checks.push({
      name: `${name}: scatter normal count`,
      pass: near(normal.count, expected.normalCount, 0, 0),
      ui: normal.count,
      exp: expected.normalCount,
    });
    checks.push({
      name: `${name}: scatter above count`,
      pass: near(above.count, expected.aboveCount, 0, 0),
      ui: above.count,
      exp: expected.aboveCount,
    });
    checks.push({
      name: `${name}: scatter below count`,
      pass: near(below.count, expected.belowCount, 0, 0),
      ui: below.count,
      exp: expected.belowCount,
    });
  } else {
    checks.push({ name: `${name}: scatter datasets present`, pass: false, ui: priceDatasets, exp: 'datasets with labels' });
  }

  const volume = chartInfo?.volume;
  if (volume) {
    checks.push({
      name: `${name}: histogram labels count`,
      pass: near(volume.labelsCount, distBinsLen, 0, 0),
      ui: volume.labelsCount,
      exp: distBinsLen,
    });
    checks.push({
      name: `${name}: histogram bars sum`,
      pass: near(volume.barSum, distTotal, 0, 0),
      ui: volume.barSum,
      exp: distTotal,
    });
  } else {
    checks.push({ name: `${name}: volume chart present`, pass: false, ui: null, exp: 'present' });
  }

  return checks;
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const summary = {
    runAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    productCode: PRODUCT_CODE,
    sections: {},
    checks: [],
    bugs: [],
  };

  // API-level batch validation across multiple products
  const productsResp = await (await fetch(`${BASE_URL}/api/products/?search=&page=1`)).json();
  const products = (productsResp.results || []).slice(0, 12);
  const apiBatch = [];

  for (const p of products) {
    try {
      const avg = await postJson(`${BASE_URL}/api/avg-price/`, { product_id: p.id, specifications: {} });
      const dist = await postJson(`${BASE_URL}/api/price-distribution/`, { product_id: p.id, specifications: {} });

      const prices = avg.prices || [];
      const outlierSums = computeOutlierSums(prices, Number(avg.avg_price));
      const minActual = Math.min(...prices.map((x) => Number(x.price)));
      const maxActual = Math.max(...prices.map((x) => Number(x.price)));

      const pass = {
        hasKeys:
          avg.avg_price != null &&
          avg.min_price != null &&
          avg.max_price != null &&
          avg.number_of_saleitems != null &&
          Array.isArray(avg.prices),
        countMatches: Number(avg.number_of_saleitems) === prices.length,
        minMatches: near(Number(avg.min_price), Math.trunc(minActual), 0.1, 0),
        maxMatches: near(Number(avg.max_price), Math.trunc(maxActual), 0.1, 0),
        coeffFormula: near(Number(avg.coeff_var), (Number(avg.std_dev) / Number(avg.avg_price)) * 100, 0.2, 0.001),
        distTotalMatches: Number(dist.total) === Number(avg.number_of_saleitems),
        distBinsSumMatches:
          (dist.bins || []).reduce((s, b) => s + Number(b.count || 0), 0) === Number(dist.total),
        outlierNonNegative: outlierSums.over >= 0 && outlierSums.under >= 0,
      };

      apiBatch.push({
        productId: p.id,
        productCode: p.code,
        productText: p.text,
        pass,
      });
    } catch (e) {
      apiBatch.push({
        productId: p.id,
        productCode: p.code,
        productText: p.text,
        error: e.message,
      });
    }
  }
  summary.sections.apiBatch = apiBatch;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const consoleErrors = [];
  const requestFails = [];
  const requestLog = [];
  const responseLog = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('requestfailed', (r) => requestFails.push({ url: r.url(), error: r.failure()?.errorText || 'unknown' }));
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/')) {
      requestLog.push({ method: r.method(), url: u, postData: r.postData() || null, ts: Date.now() });
    }
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/')) {
      responseLog.push({ url: u, status: r.status(), ts: Date.now() });
    }
  });

  const waitApiCycle = async (startIndex, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const slice = responseLog.slice(startIndex);
      const hasAvg = slice.some((x) => x.url.includes('/api/avg-price/') && x.status === 200);
      const hasDist = slice.some((x) => x.url.includes('/api/price-distribution/') && x.status === 200);
      if (hasAvg && hasDist) {
        await page.waitForTimeout(1200);
        return true;
      }
      await page.waitForTimeout(200);
    }
    return false;
  };

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  // ensure product selector is available, retry with reload on transient failures
  let comboReady = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const roleCombo = page.locator('[role="combobox"]').first();
    const select2Combo = page.locator('.select2-selection.select2-selection--single').first();
    if ((await roleCombo.count()) > 0 || (await select2Combo.count()) > 0) {
      comboReady = true;
      break;
    }
    if (attempt < 3) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
    }
  }
  if (!comboReady) {
    throw new Error('Product selector not found after retries');
  }

  // select target product
  if ((await page.locator('[role="combobox"]').count()) > 0) {
    await page.locator('[role="combobox"]').first().click();
  } else {
    await page.locator('.select2-selection.select2-selection--single').first().click();
  }
  await page.waitForTimeout(600);
  await page.locator('input.select2-search__field').first().fill(PRODUCT_CODE);
  await page.waitForTimeout(900);
  let rStart = responseLog.length;
  await page.locator('li[role="option"]', { hasText: PRODUCT_CODE }).first().click();
  await waitApiCycle(rStart);

  // baseline state (all specs)
  const uiBaseline = await captureUiState(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'deep-baseline.png'), fullPage: true });

  const baselineAvg = await postJson(`${BASE_URL}/api/avg-price/`, { product_id: 1195, specifications: {} });
  const baselineDist = await postJson(`${BASE_URL}/api/price-distribution/`, { product_id: 1195, specifications: {} });
  const baselineOutliers = computeOutlierSums(baselineAvg.prices, Number(baselineAvg.avg_price));
  const baselineExpected = {
    min: Number(baselineAvg.min_price),
    avg: Number(baselineAvg.avg_price),
    max: Number(baselineAvg.max_price),
    count: Number(baselineAvg.number_of_saleitems),
    std: Number(baselineAvg.std_dev),
    coeff: Number(baselineAvg.coeff_var),
    over: baselineOutliers.over,
    under: baselineOutliers.under,
    total: baselineOutliers.total,
    aboveCount: baselineOutliers.aboveCount,
    belowCount: baselineOutliers.belowCount,
    normalCount: baselineOutliers.normalCount,
  };

  summary.checks.push(
    ...assessState(
      'baseline-default',
      mapUiCardNumbers(uiBaseline.cards),
      baselineExpected,
      uiBaseline.charts,
      Number(baselineDist.total),
      (baselineDist.bins || []).length,
    ),
  );

  // Collect spec options and select target values
  const specDefs = await (await fetch(`${BASE_URL}/api/products/1195/specifications/`)).json();
  const findSpec = (needle) => (specDefs.specifications || []).find((s) => (s.name || '').toLowerCase().includes(needle));
  const unitSpec = findSpec('unit');
  const octaneSpec = findSpec('octane');
  const ecoSpec = findSpec('ecological');

  const pickValue = (spec, preferred) => {
    if (!spec) return null;
    const vals = spec.values || [];
    const found = vals.find((v) => (v.name || '').toLowerCase().includes(preferred));
    return found ? found.id : vals[0]?.id;
  };

  const unitVal = pickValue(unitSpec, 'l');
  const octaneVal = pickValue(octaneSpec, '80 and < 92');
  const ecoVal = pickValue(ecoSpec, 'k4');

  if (unitVal) {
    rStart = responseLog.length;
    await page.locator('select.spec-select').nth(0).selectOption(String(unitVal));
    await waitApiCycle(rStart);
  }
  if (octaneVal) {
    rStart = responseLog.length;
    await page.locator('select.spec-select').nth(1).selectOption(String(octaneVal));
    await waitApiCycle(rStart);
  }
  if (ecoVal) {
    rStart = responseLog.length;
    await page.locator('select.spec-select').nth(2).selectOption(String(ecoVal));
    await waitApiCycle(rStart);
  }

  const selectedSpecs = {};
  if (unitSpec && unitVal) selectedSpecs[String(unitSpec.id)] = Number(unitVal);
  if (octaneSpec && octaneVal) selectedSpecs[String(octaneSpec.id)] = Number(octaneVal);
  if (ecoSpec && ecoVal) selectedSpecs[String(ecoSpec.id)] = Number(ecoVal);

  const uiFiltered = await captureUiState(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'deep-filtered.png'), fullPage: true });

  const filteredAvg = await postJson(`${BASE_URL}/api/avg-price/`, { product_id: 1195, specifications: selectedSpecs });
  const filteredDist = await postJson(`${BASE_URL}/api/price-distribution/`, { product_id: 1195, specifications: selectedSpecs });
  const filteredOutliers = computeOutlierSums(filteredAvg.prices, Number(filteredAvg.avg_price));

  const filteredExpected = {
    min: Number(filteredAvg.min_price),
    avg: Number(filteredAvg.avg_price),
    max: Number(filteredAvg.max_price),
    count: Number(filteredAvg.number_of_saleitems),
    std: Number(filteredAvg.std_dev),
    coeff: Number(filteredAvg.coeff_var),
    over: filteredOutliers.over,
    under: filteredOutliers.under,
    total: filteredOutliers.total,
    aboveCount: filteredOutliers.aboveCount,
    belowCount: filteredOutliers.belowCount,
    normalCount: filteredOutliers.normalCount,
  };

  summary.checks.push(
    ...assessState(
      'filtered-unit-octane-eco',
      mapUiCardNumbers(uiFiltered.cards),
      filteredExpected,
      uiFiltered.charts,
      Number(filteredDist.total),
      (filteredDist.bins || []).length,
    ),
  );

  // AI ON in filtered state
  rStart = responseLog.length;
  await page.locator('label.toggle-switch').click();
  await waitApiCycle(rStart);
  await page.waitForTimeout(2500);

  const uiFilteredAi = await captureUiState(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'deep-filtered-ai-on.png'), fullPage: true });

  const filteredBins = filteredDist.bins || [];
  const specText = uiFiltered.specs
    .filter((s) => s.value)
    .map((s) => `${s.index}: ${s.selectedText || ''}`);

  const aiBounds = await postJson(`${BASE_URL}/api/ai-outliers/`, {
    product_id: 1195,
    specifications: selectedSpecs,
    specifications_text: specText,
    bins: filteredBins,
  });

  const removed = await postJson(`${BASE_URL}/api/removed-outliers/`, {
    product_id: 1195,
    specifications: selectedSpecs,
    price_min: aiBounds.ai_min_price,
    price_max: aiBounds.ai_max_price,
  });

  const aiExpected = computeAiAdjustedMetrics(filteredAvg, removed.outliers || []);
  const filteredPricesAfterAi = removeOutliers(filteredAvg.prices, removed.outliers || []);
  const filteredAiBinsLen = new Set(filteredPricesAfterAi.map((x) => Number(x.price))).size;
  const uiFilteredAiNums = mapUiCardNumbers(uiFilteredAi.cards);

  summary.checks.push({
    name: 'filtered-ai: ai toggle checked',
    pass: uiFilteredAi.aiChecked === true,
    ui: uiFilteredAi.aiChecked,
    exp: true,
  });
  summary.checks.push({
    name: 'filtered-ai: aiUp',
    pass: near(uiFilteredAiNums.aiUp ?? 0, aiExpected.aiUp ?? 0, 2_000_000, 0.1),
    ui: uiFilteredAiNums.aiUp,
    exp: aiExpected.aiUp,
  });
  summary.checks.push({
    name: 'filtered-ai: aiDown',
    pass: near(uiFilteredAiNums.aiDown ?? 0, aiExpected.aiDown ?? 0, 2_000_000, 0.1),
    ui: uiFilteredAiNums.aiDown,
    exp: aiExpected.aiDown,
  });

  summary.checks.push(
    ...assessState(
      'filtered-ai-adjusted',
      uiFilteredAiNums,
      {
        min: aiExpected.min,
        avg: aiExpected.avg,
        max: aiExpected.max,
        count: aiExpected.count,
        std: aiExpected.std,
        coeff: aiExpected.coeff,
        over: aiExpected.over,
        under: aiExpected.under,
        total: aiExpected.total,
        aboveCount: computeOutlierSums(removeOutliers(filteredAvg.prices, removed.outliers || []), aiExpected.avg).aboveCount,
        belowCount: computeOutlierSums(removeOutliers(filteredAvg.prices, removed.outliers || []), aiExpected.avg).belowCount,
        normalCount: computeOutlierSums(removeOutliers(filteredAvg.prices, removed.outliers || []), aiExpected.avg).normalCount,
      },
      uiFilteredAi.charts,
      aiExpected.count,
      filteredAiBinsLen,
    ),
  );

  summary.sections.filtered = {
    selectedSpecs,
    aiBounds,
    removedOutliersCount: removed.count,
  };

  // Default state AI toggle validation (clear filters first)
  rStart = responseLog.length;
  await page.locator('select.spec-select').nth(0).selectOption('');
  await waitApiCycle(rStart);
  rStart = responseLog.length;
  await page.locator('select.spec-select').nth(1).selectOption('');
  await waitApiCycle(rStart);
  rStart = responseLog.length;
  await page.locator('select.spec-select').nth(2).selectOption('');
  await waitApiCycle(rStart);

  // Toggle off if currently on
  if (await page.locator('#ai-outliers-ai-cb').isChecked()) {
    await page.locator('label.toggle-switch').click();
    await page.waitForTimeout(1500);
  }

  rStart = responseLog.length;
  await page.locator('label.toggle-switch').click();
  await waitApiCycle(rStart);
  await page.waitForTimeout(3000);

  const uiDefaultAi = await captureUiState(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'deep-default-ai-on.png'), fullPage: true });

  const baseBins = baselineDist.bins || [];
  const aiBoundsDefault = await postJson(`${BASE_URL}/api/ai-outliers/`, {
    product_id: 1195,
    specifications: {},
    specifications_text: [],
    bins: baseBins,
  });
  const removedDefault = await postJson(`${BASE_URL}/api/removed-outliers/`, {
    product_id: 1195,
    specifications: {},
    price_min: aiBoundsDefault.ai_min_price,
    price_max: aiBoundsDefault.ai_max_price,
  });
  const aiExpectedDefault = computeAiAdjustedMetrics(baselineAvg, removedDefault.outliers || []);
  const defaultPricesAfterAi = removeOutliers(baselineAvg.prices, removedDefault.outliers || []);
  const defaultAiBinsLen = new Set(defaultPricesAfterAi.map((x) => Number(x.price))).size;
  const uiDefaultAiNums = mapUiCardNumbers(uiDefaultAi.cards);

  summary.checks.push({ name: 'default-ai: ai toggle checked', pass: uiDefaultAi.aiChecked === true, ui: uiDefaultAi.aiChecked, exp: true });
  summary.checks.push({
    name: 'default-ai: removed outlier count > 0',
    pass: Number(removedDefault.count) > 0,
    ui: removedDefault.count,
    exp: '>0',
  });

  summary.checks.push(
    ...assessState(
      'default-ai-adjusted',
      uiDefaultAiNums,
      {
        min: aiExpectedDefault.min,
        avg: aiExpectedDefault.avg,
        max: aiExpectedDefault.max,
        count: aiExpectedDefault.count,
        std: aiExpectedDefault.std,
        coeff: aiExpectedDefault.coeff,
        over: aiExpectedDefault.over,
        under: aiExpectedDefault.under,
        total: aiExpectedDefault.total,
        ...computeOutlierSums(removeOutliers(baselineAvg.prices, removedDefault.outliers || []), aiExpectedDefault.avg),
      },
      uiDefaultAi.charts,
      aiExpectedDefault.count,
      defaultAiBinsLen,
    ),
  );

  summary.checks.push({
    name: 'default-ai: aiDown value',
    pass: near(uiDefaultAiNums.aiDown || 0, aiExpectedDefault.aiDown || 0, 2_000_000, 0.1),
    ui: uiDefaultAiNums.aiDown,
    exp: aiExpectedDefault.aiDown,
  });

  // Localization + option normalization checks
  const unitOptions = uiBaseline.specs[0]?.options?.map((o) => o.text) || [];
  const hasL = unitOptions.some((x) => x.toLowerCase() === 'l');
  const hasLiter = unitOptions.some((x) => x.toLowerCase() === 'liter');
  summary.checks.push({
    name: 'localization: mixed languages present',
    pass: !(uiBaseline.localizationMarkers.hasRu && uiBaseline.localizationMarkers.hasEn && uiBaseline.localizationMarkers.hasUz),
    ui: uiBaseline.localizationMarkers,
    exp: 'single locale markers',
  });
  summary.checks.push({
    name: 'normalization: duplicate unit semantics l/liter absent',
    pass: !(hasL && hasLiter),
    ui: unitOptions,
    exp: 'no semantic duplicates',
  });

  // Mobile check
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mobileErrors = [];
  const mobileFails = [];
  mobile.on('console', (m) => {
    if (m.type() === 'error') mobileErrors.push(m.text());
  });
  mobile.on('requestfailed', (r) => mobileFails.push({ url: r.url(), error: r.failure()?.errorText || 'unknown' }));

  await mobile.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await mobile.waitForTimeout(1200);
  await mobile.locator('[role="combobox"]').first().click();
  await mobile.waitForTimeout(600);
  await mobile.locator('input.select2-search__field').first().fill(PRODUCT_CODE);
  await mobile.waitForTimeout(900);
  await mobile.locator('li[role="option"]', { hasText: PRODUCT_CODE }).first().click();
  await mobile.waitForTimeout(7000);

  const mobileState = await mobile.evaluate(() => ({
    viewportW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    canvasCount: document.querySelectorAll('canvas').length,
  }));

  await mobile.screenshot({ path: path.join(OUT_DIR, 'deep-mobile.png'), fullPage: true });
  await mobile.close();

  summary.sections.mobile = {
    ...mobileState,
    consoleErrorCount: mobileErrors.length,
    requestFailCount: mobileFails.length,
    consoleErrorsSample: mobileErrors.slice(0, 30),
  };

  summary.checks.push({
    name: 'mobile: no horizontal overflow',
    pass: mobileState.overflowX === false,
    ui: mobileState.overflowX,
    exp: false,
  });
  summary.checks.push({
    name: 'mobile: no chart rendering console errors',
    pass: mobileErrors.length === 0,
    ui: mobileErrors.length,
    exp: 0,
  });

  // classify bugs
  const failedChecks = summary.checks.filter((c) => !c.pass);
  const hasMobileChartError = failedChecks.some((c) => c.name === 'mobile: no chart rendering console errors');
  const hasLocaleMix = failedChecks.some((c) => c.name === 'localization: mixed languages present');
  const hasUnitDup = failedChecks.some((c) => c.name === 'normalization: duplicate unit semantics l/liter absent');

  if (hasMobileChartError) {
    summary.bugs.push({
      id: 'BUG-AP-001',
      title: 'Mobile chart rendering throws SVG negative width errors',
      priority: 'High',
      screen: path.join(OUT_DIR, 'deep-mobile.png'),
    });
  }
  if (hasLocaleMix) {
    summary.bugs.push({
      id: 'BUG-AP-002',
      title: 'Localization mixed in one screen (RU/EN/UZ)',
      priority: 'Medium',
      screen: path.join(OUT_DIR, 'deep-baseline.png'),
    });
  }
  if (hasUnitDup) {
    summary.bugs.push({
      id: 'BUG-AP-003',
      title: 'Unit options contain semantic duplicates (l and liter)',
      priority: 'Medium-Low',
      screen: path.join(OUT_DIR, 'deep-filtered.png'),
    });
  }

  summary.sections.desktop = {
    consoleErrorCount: consoleErrors.length,
    requestFailCount: requestFails.length,
    consoleErrorsSample: consoleErrors.slice(0, 20),
    requestFailsSample: requestFails.slice(0, 20),
  };

  summary.stats = {
    totalChecks: summary.checks.length,
    passedChecks: summary.checks.filter((c) => c.pass).length,
    failedChecks: summary.checks.filter((c) => !c.pass).length,
    apiProductsChecked: apiBatch.length,
    apiProductsAllPassed: apiBatch.filter((x) => x.pass && Object.values(x.pass).every(Boolean)).length,
  };

  const jsonPath = path.resolve(__dirname, '../artifacts/qa-docs/deep_audit_results.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(JSON.stringify({ jsonPath, stats: summary.stats, bugs: summary.bugs }, null, 2));

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

