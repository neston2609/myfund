import fs from "node:fs/promises";
import path from "node:path";

const profilesDir = "profiles";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function getFundList() {
  const list = await fetchJson("https://www.finnomena.com/fn3/api/fund/public/list");
  return Array.isArray(list) ? list : list.value ?? [];
}

async function getNavFromFinnomena(code, fundList) {
  const fund = fundList.find((item) => item.short_code === code);
  if (!fund) {
    throw new Error(`Fund code not found in Finnomena public list: ${code}`);
  }

  for (const range of ["1M", "1Y", "MAX"]) {
    const navUrl = `https://www.finnomena.com/fn3/api/fund/v2/public/funds/nav/q?funds[]=${encodeURIComponent(fund.id)}&range=${range}`;
    const payload = await fetchJson(navUrl);
    const record = payload.data?.find((item) => item.fund_id === fund.id);
    const latest = record?.navs?.at(-1);
    if (latest && typeof latest.value === "number") {
      return {
        code,
        nameTh: fund.name_th,
        nav: latest.value,
        navDate: latest.date ?? null,
        sourceUrl: `https://www.finnomena.com/fund/${encodeURIComponent(code)}`,
      };
    }
  }

  throw new Error(`NAV not found in Finnomena nav series for ${code}`);
}

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

async function main() {
  const fundList = await getFundList();
  const profileFiles = (await fs.readdir(profilesDir)).filter((file) => file.endsWith(".json"));
  const results = [];

  for (const file of profileFiles) {
    const dataPath = path.join(profilesDir, file);
    const raw = await fs.readFile(dataPath, "utf8");
    const currentData = JSON.parse(raw);
    const fundCodes = [...new Set((currentData.funds ?? []).map((fund) => fund.code).filter(Boolean))];
    if (!fundCodes.length) {
      results.push({ profile: path.basename(file, ".json"), funds: [], holdings: currentData.holdings?.length ?? 0, skipped: true });
      continue;
    }

    const previousFunds = new Map((currentData.funds ?? []).map((fund) => [fund.code, fund]));
    const updatedFunds = [];
    const errors = [];
    for (const code of fundCodes) {
      try {
        const update = await getNavFromFinnomena(code, fundList);
        const previous = previousFunds.get(code) ?? {};
        updatedFunds.push({
          ...previous,
          ...update,
          navDateDisplay: formatDate(update.navDate),
          holdYears: previous.holdYears ?? 0,
        });
      } catch (error) {
        errors.push({ code, error: error.message });
        updatedFunds.push(previousFunds.get(code));
      }
    }

    const updatedAt = new Date().toISOString();
    const nextData = calculateData({
      ...currentData,
      updatedAt,
      source: "https://www.finnomena.com/",
      funds: updatedFunds.filter(Boolean),
    });
    delete nextData.rows;

    await fs.writeFile(dataPath, `${JSON.stringify(nextData, null, 2)}\n`, "utf8");
    results.push({
      profile: nextData.profile?.slug ?? path.basename(file, ".json"),
      updatedAt,
      funds: nextData.funds.map((fund) => ({
        code: fund.code,
        nav: fund.nav,
        navDate: fund.navDateDisplay,
      })),
      holdings: nextData.holdings.length,
      portfolioTotals: nextData.portfolioTotals,
      errors,
    });
  }

  console.log(JSON.stringify({ profiles: results }, null, 2));
}

await main();
