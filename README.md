# k6 + Prometheus + Grafana + Playwright

Bu loyiha endi 2 xil vazifani aniq ajratadi:
- `k6`: yuqori RPS HTTP load. API yoki HTML page + asset fan-out uchun.
- `Playwright`: real brauzer ichida front-end performance audit. `TTFB`, `FCP`, `LCP`, `CLS`, `load`, `TBT`, request failure va browser errorlarni yig'adi.

Muhim: `k6` yakka o'zi to'liq front-end render test emas. U render vaqtini emas, server/CDN/static asset delivery bosimini ko'rsatadi. Render va UX tomoni `Playwright` summary bilan tekshiriladi.

Muhim: faqat siz egalik qiladigan yoki yozma ruxsat berilgan tizimlarda ishlating.

## 1) Tayyorlash

```powershell
Copy-Item .env.example .env
```

`.env` ichida kamida bularni to'ldiring:
- `LOAD_TEST_URL`: `k6` uradigan API yoki sahifa URL.
- `PAGE_URL`: `Playwright` ochadigan UI sahifa URL.
- `LOAD_REQUEST_HEADERS`: auth yoki kerakli headerlar.
- `LOAD_EXPECTED_STATUS_CODES`: muvaffaqiyat deb hisoblanadigan statuslar.

## 2) Monitoring stack

```powershell
docker compose up -d prometheus grafana
```

Yoki hammasini parallel ishga tushirish:

```powershell
.\run-all.ps1
```

Linux/macOS uchun `run-all.sh` yoki `PowerShell 7` (`pwsh`) bilan ishga tushiring:

```bash
./run-all.sh
```

Yoki:

```bash
pwsh ./run-all.ps1
```

URL:
- Grafana: `http://localhost:${GRAFANA_PORT}` (default `3001`)
- Prometheus: `http://localhost:${PROMETHEUS_PORT}` (default `9090`)
- k6 dashboard: `http://localhost:${GRAFANA_PORT}/d/k6-load-overview/k6-load-overview`

## 3) k6 load test

Oddiy HTTP load:

```powershell
docker compose --profile load run --rm k6
```

Default maqsad:
- `LOAD_MODE=ramp`
- `LOAD_START_RATE=20`
- `LOAD_STAGES=50:1m,100:1m,150:1m,200:1m,250:1m,300:1m`
- `LOAD_PRE_ALLOCATED_VUS=500`
- `LOAD_MAX_VUS=2500`

`constant` rejim:
- `LOAD_MODE=constant`
- `LOAD_RATE=300`
- `LOAD_DURATION=2m`

### Front-end page loadga yaqinroq k6 rejim

Agar `LOAD_TEST_URL` HTML sahifa bo'lsa, `k6` CSS/JS assetlarni ham batch qilib urishi mumkin:

```env
LOAD_INCLUDE_PAGE_ASSETS=true
LOAD_INCLUDE_PAGE_IMAGES=false
LOAD_MAX_PAGE_ASSETS=24
LOAD_PAGE_ASSET_HOSTS=cdn.example.com,static.example.com
LOAD_ACCEPTABLE_PAGE_P95_MS=5000
```

Bu rejim quyidagilarni beradi:
- `page_document_duration`
- `page_asset_batch_duration`
- `page_total_duration`
- `page_asset_count`
- `page_asset_failures`

Eslatma:
- bu browser render vaqtini bermaydi;
- lekin HTML + static asset bosimini front-end nuqtai nazardan ancha realroq ko'rsatadi.
- `LOAD_RATE` bu yerda `page views/sec`; masalan `300` page/s va har page `5` asset bo'lsa, backend tomonda taxminan `1500+ req/s` hosil bo'ladi.

## 4) Playwright front-end audit

```powershell
docker compose --profile ui run --rm playwright
```

Natijalar:
- HTML report: `artifacts/playwright-report`
- JSON report: `artifacts/playwright-report/results.json`
- Front-end summary: `artifacts/frontend-performance/summary.json`
- O'qishga qulay summary: `artifacts/frontend-performance/summary.md`
- Checkpoint screenshotlar: `artifacts/frontend-performance/checkpoints`
- Video/trace/failure artifacts: `artifacts/test-results`

Yig'iladigan metrikalar:
- `TTFB`
- `FCP`
- `LCP`
- `CLS`
- `load`
- `totalBlockingTime`
- `resourceCount`
- `transferSize`
- `requestFailures`, `httpErrors`, `pageErrors`

Bir nechta route bo'yicha flow qilish mumkin:

```env
PAGE_URL=https://example.com
PAGE_URLS=https://example.com,https://example.com/about,https://example.com/pricing
FRONTEND_ROUTE_DELAY_MS=300
```

Bu holda report:
- overall summary
- har route bo'yicha p95
- first-load vs repeat-load farqini chiqaradi

Thresholdlar `.env` orqali boshqariladi:
- `FRONTEND_MAX_TTFB_MS`
- `FRONTEND_MAX_FCP_MS`
- `FRONTEND_MAX_LCP_MS`
- `FRONTEND_MAX_LOAD_MS`
- `FRONTEND_MAX_CLS`
- `FRONTEND_MAX_TOTAL_BLOCKING_TIME_MS`
- `FRONTEND_MAX_FAILED_REQUESTS`
- `FRONTEND_MAX_HTTP_ERRORS`
- `FRONTEND_MAX_PAGE_ERRORS`

## 5) Video va screenshot bo'yicha tavsiya

Ha, video va screenshot foydali. Lekin ular asosiy KPI emas.

To'g'ri ishlatish:
- video: failure bo'lsa saqlash (`PLAYWRIGHT_VIDEO=retain-on-failure`)
- screenshot: failure yoki periodik checkpoint (`PLAYWRIGHT_CAPTURE_EVERY_N=5`)
- trace: failure debugging uchun (`PLAYWRIGHT_TRACE=retain-on-failure`)

Noto'g'ri ishlatish:
- har loopda full-page screenshot olish
- videoni barcha run uchun majburiy yoqib qo'yish
- performance qarorini faqat vizual artefaktga qarab chiqarish

## 6) Qanchalik effektiv?

Hozirgi setup quyidagicha baholanadi:
- API/server load uchun: yaxshi
- Front-end static delivery uchun: yaxshi, agar `LOAD_INCLUDE_PAGE_ASSETS=true` yoqilib, real asset hostlar kiritilsa
- Real browser UX/performance uchun: yaxshi, chunki endi `Playwright` summary metrikalarni JSON/Markdown ko'rinishda, route kesimida ham beradi
- Yuqori concurrent real browser load uchun: o'rtacha, chunki `Playwright` load generator emas; bu yerda u audit vositasi

## 7) Keyinroq qo'shish mumkin bo'lgan narsalar

Eng foydali qo'shimchalar:
- login, search, checkout kabi real user flow bo'yicha alohida scenariylar
- mobil va desktop uchun alohida `PAGE_URL` profillari
- CDN cache warm/cold test
- Lighthouse yoki `k6/browser` bilan qo'shimcha synthetic audit
- asosiy assetlar uchun size budget va cache-header check

## 8) Tezkor run

Faqat `k6`:

```powershell
docker compose up -d prometheus
docker compose --profile load run --rm k6
```

Faqat `Playwright`:

```powershell
docker compose --profile ui run --rm playwright
```
