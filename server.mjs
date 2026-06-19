import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(rootDir, "web");
const dataPath = path.join(webDir, "data.json");
const port = Number(process.env.PORT ?? 8010);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(value));
}

function maturityStatus(purchaseYear, holdYears, currentYear = new Date().getFullYear()) {
  const maturityYear = numberValue(purchaseYear) + numberValue(holdYears);
  if (currentYear >= maturityYear) return `ครบกำหนด (${maturityYear})`;
  return `ยังไม่ครบกำหนด (ครบกำหนดปี ${maturityYear})`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readData() {
  return JSON.parse(await fs.readFile(dataPath, "utf8"));
}

async function writeData(data) {
  await fs.writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function calculateData(data) {
  const fundsByCode = new Map((data.funds ?? []).map((fund) => [fund.code, fund]));
  const holdings = (data.holdings ?? []).map((holding, index) => {
    const fund = fundsByCode.get(holding.code);
    const purchaseYear = numberValue(holding.purchaseYear);
    const cost = numberValue(holding.cost);
    const units = numberValue(holding.units);
    const holdYears = numberValue(holding.holdYears ?? fund?.holdYears);
    const nav = numberValue(fund?.nav ?? holding.nav);
    const currentValue = units * nav;
    const gain = currentValue - cost;

    return {
      id: holding.id ?? `web-seed-${index + 1}`,
      source: "web",
      purchaseYear,
      code: String(holding.code ?? ""),
      cost,
      units,
      nav,
      currentValue,
      gain,
      gainPct: cost ? gain / cost : null,
      holdYears,
      maturityYear: purchaseYear + holdYears,
      status: maturityStatus(purchaseYear, holdYears),
    };
  });

  const portfolioTotals = holdings.reduce(
    (acc, holding) => {
      acc.cost += holding.cost;
      acc.currentValue += holding.currentValue;
      acc.gain += holding.gain;
      return acc;
    },
    { cost: 0, currentValue: 0, gain: 0 },
  );

  return { ...data, holdings, portfolioTotals };
}

// --- Finnomena NAV fetcher ---
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json,text/html;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function getFinnomenaFundList() {
  const list = await fetchJson("https://www.finnomena.com/fn3/api/fund/public/list");
  return Array.isArray(list) ? list : (list.value ?? []);
}

async function getNavFromFinnomena(code, fundList) {
  const fund = fundList.find((item) => item.short_code === code);
  if (!fund) throw new Error(`Fund not found in Finnomena: ${code}`);
  for (const range of ["1M", "1Y", "MAX"]) {
    const url = `https://www.finnomena.com/fn3/api/fund/v2/public/funds/nav/q?funds[]=${encodeURIComponent(fund.id)}&range=${range}`;
    const payload = await fetchJson(url);
    const record = payload.data?.find((item) => item.fund_id === fund.id);
    const latest = record?.navs?.at(-1);
    if (latest && typeof latest.value === "number") {
      return { nav: latest.value, navDate: latest.date ?? null, nameTh: fund.name_th };
    }
  }
  throw new Error(`NAV not found for ${code}`);
}

async function refreshNavFromFinnomena(currentData) {
  const fundList = await getFinnomenaFundList();
  const updatedFunds = [];
  const errors = [];

  for (const fund of currentData.funds ?? []) {
    try {
      const update = await getNavFromFinnomena(fund.code, fundList);
      updatedFunds.push({
        ...fund,
        nav: update.nav,
        navDate: update.navDate,
        navDateDisplay: formatDate(update.navDate),
        nameTh: update.nameTh ?? fund.nameTh ?? "",
        sourceUrl: `https://www.finnomena.com/fund/${encodeURIComponent(fund.code)}`,
      });
    } catch (err) {
      errors.push({ code: fund.code, error: err.message });
      updatedFunds.push(fund);
    }
  }

  return { updatedFunds, errors };
}

// --- HTTP handlers ---
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function serveStatic(request, response, url) {
  const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const absolutePath = path.resolve(webDir, `.${requestPath}`);
  if (!absolutePath.startsWith(webDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(absolutePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(absolutePath)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    // GET /api/data — read + recalculate
    if (request.method === "GET" && url.pathname === "/api/data") {
      sendJson(response, 200, calculateData(await readData()));
      return;
    }

    // POST /api/refresh-nav — fetch latest NAV from Finnomena, save, return updated data
    if (request.method === "POST" && url.pathname === "/api/refresh-nav") {
      const current = await readData();
      const { updatedFunds, errors } = await refreshNavFromFinnomena(current);
      const updatedAt = new Date().toISOString();
      const next = calculateData({
        ...current,
        updatedAt,
        source: "https://www.finnomena.com/",
        funds: updatedFunds,
      });
      delete next.rows;
      await writeData(next);
      sendJson(response, 200, { ...next, navRefreshErrors: errors });
      return;
    }

    // PUT /api/holdings — replace holdings array
    if (request.method === "PUT" && url.pathname === "/api/holdings") {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.holdings)) {
        sendJson(response, 400, { error: "holdings must be an array" });
        return;
      }
      const current = await readData();
      const next = calculateData({
        ...current,
        updatedAt: new Date().toISOString(),
        holdings: body.holdings,
      });
      delete next.rows;
      await writeData(next);
      sendJson(response, 200, next);
      return;
    }

    // PUT /api/funds — replace funds array
    if (request.method === "PUT" && url.pathname === "/api/funds") {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.funds)) {
        sendJson(response, 400, { error: "funds must be an array" });
        return;
      }
      const current = await readData();
      const next = calculateData({
        ...current,
        updatedAt: new Date().toISOString(),
        funds: body.funds,
      });
      delete next.rows;
      await writeData(next);
      sendJson(response, 200, next);
      return;
    }

    await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MyFund web app: http://127.0.0.1:${port}/`);
});
