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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
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
    if (request.method === "GET" && url.pathname === "/api/data") {
      sendJson(response, 200, calculateData(await readData()));
      return;
    }

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

    await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MyFund web app: http://127.0.0.1:${port}/`);
});
