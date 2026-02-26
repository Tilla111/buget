# k6 + Prometheus + Grafana + Playwright (Docker)

Bu loyiha:
- `k6` bilan stress test (`1 sekundda 5000 request` maqsad).
- `Prometheus`ga k6 metrikalarini yozish.
- `Grafana`da metrikalarni ko'rish.
- `Playwright` bilan UI loop test, video va screenshotlar olish.

Muhim: faqat siz egalik qiladigan yoki yozma ruxsat berilgan tizimlarda ishlating.

## 1) Tayyorlash

1. `.env.example` faylidan nusxa oling:

```powershell
Copy-Item .env.example .env
```

2. `.env` ichida kamida quyidagilarni to'ldiring:
- `LOAD_TEST_URL` - load test qilinadigan API endpoint.
- `PAGE_URL` - Playwright ochadigan UI sahifa URL.
- `LOAD_REQUEST_HEADERS` - kerak bo'lsa bearer token va boshqa headerlar.
- `LOAD_REQUEST_BODY` - POST/PUT bo'lsa payload.
- `LOAD_REQUEST_TIMEOUT` - bitta request timeout (masalan `15s`).
- `LOAD_EXPECTED_STATUS_CODES` - muvaffaqiyat deb hisoblanadigan statuslar (masalan `200,301,302,304`).

## 2) Monitoring stackni ishga tushirish

```powershell
docker compose up -d prometheus grafana
```

Yoki hammasini bitta buyruq bilan parallel ishga tushirish:

```powershell
.\run-all.ps1
```

Kirish URL:
- Grafana: `http://localhost:${GRAFANA_PORT}` (default: `3001`)
- Prometheus: `http://localhost:${PROMETHEUS_PORT}` (default: `9090`)
- k6 dashboard: `http://localhost:${GRAFANA_PORT}/d/k6-load-overview/k6-load-overview`

Grafana login:
- user: `.env` dagi `GRAFANA_USER`
- pass: `.env` dagi `GRAFANA_PASSWORD`

## 3) k6 stress test (`5000 rps`)

```powershell
docker compose --profile load run --rm k6
```

Eslatma: test boshlanishida `preflight` so'rov yuboriladi. Agar URL `500/403/...` qaytarsa test darhol to'xtaydi.

Muhim sozlamalar (`.env`):
- `LOAD_MODE=ramp` (default)
- `LOAD_START_RATE=100`
- `LOAD_STAGES=200:1m,500:1m,1000:1m,2000:1m,3500:1m,5000:1m` (jami 6 minut, sekin ramp)
- `LOAD_PRE_ALLOCATED_VUS=200`
- `LOAD_MAX_VUS=800`

`constant` rejim kerak bo'lsa:
- `LOAD_MODE=constant`
- `LOAD_RATE=5000`
- `LOAD_DURATION=2m`

## 4) Playwright UI loop + video/screenshot

```powershell
docker compose --profile ui run --rm playwright
```

Natijalar:
- Screenshot va video: `artifacts/test-results`
- HTML report: `artifacts/playwright-report`
- Runtime loglar: `artifacts/k6.out.log`, `artifacts/k6.err.log`, `artifacts/playwright.out.log`, `artifacts/playwright.err.log`

## 5) Sizdan kerak bo'ladigan ma'lumotlar

Minimal:
1. API URL (`LOAD_TEST_URL`)
2. UI URL (`PAGE_URL`)
3. Auth turi (Bearer token/cookie/api-key)
4. Request turi (`GET/POST/...`) va payload
5. Qabul mezoni:
   - masalan `p95 < 800ms`
   - `error rate < 1%`

Qo'shimcha (aniqroq test uchun):
1. Real user flow endpointlari (login, list, create, update, ...)
2. Test muhit limiti (CPU, RAM, DB pool)
3. Test vaqti (peak/soak), masalan `2m`, `15m`, `1h`

## 6) Tavsiya

`5000 rps` odatda bitta mashinada yetarli bo'lmasligi mumkin. k6 generator resursi yetmasa:
- `LOAD_PRE_ALLOCATED_VUS` va `LOAD_MAX_VUS`ni oshiring.
- Kerak bo'lsa loadni bir nechta generatorga bo'ling.

## 7) Tezkor run (faqat)

Faqat `k6` run:

```powershell
cd d:\buget
docker compose up -d prometheus
docker compose --profile load run --rm k6
```

Faqat `Playwright` run:

```powershell
cd d:\buget
docker compose --profile ui run --rm playwright
```
