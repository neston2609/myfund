const STORAGE_KEY = "myfund-holdings-v2";
const API_DATA_URL = "/api/data";
const API_HOLDINGS_URL = "/api/holdings";

const navFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const moneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const pctFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  style: "percent",
});

const dateTimeFormat = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
});

let data = null;
let fundsByCode = new Map();
let holdings = [];
let apiEnabled = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value) {
  return Number.isFinite(value) ? moneyFormat.format(value) : "-";
}

function formatNav(value) {
  return Number.isFinite(value) ? navFormat.format(value) : "-";
}

function formatPct(value) {
  return Number.isFinite(value) ? pctFormat.format(value) : "-";
}

function maturityStatus(purchaseYear, holdYears) {
  const maturityYear = numberValue(purchaseYear) + numberValue(holdYears);
  const currentYear = new Date().getFullYear();
  if (currentYear >= maturityYear) return `ครบกำหนด (${maturityYear})`;
  return `ยังไม่ครบกำหนด (ครบกำหนดปี ${maturityYear})`;
}

function calculateHolding(rawHolding) {
  const fund = fundsByCode.get(rawHolding.code);
  const purchaseYear = numberValue(rawHolding.purchaseYear);
  const cost = numberValue(rawHolding.cost);
  const units = numberValue(rawHolding.units);
  const holdYears = numberValue(rawHolding.holdYears ?? fund?.holdYears ?? 0);
  const nav = numberValue(fund?.nav ?? rawHolding.nav);
  const currentValue = units * nav;
  const gain = currentValue - cost;

  return {
    ...rawHolding,
    purchaseYear,
    cost,
    units,
    holdYears,
    nav,
    currentValue,
    gain,
    gainPct: cost ? gain / cost : 0,
    maturityYear: purchaseYear + holdYears,
    status: maturityStatus(purchaseYear, holdYears),
    navDateDisplay: fund?.navDateDisplay ?? "",
    nameTh: fund?.nameTh ?? "",
  };
}

function normalizeHolding(holding) {
  return {
    id: holding.id ?? `web-${Date.now()}`,
    source: "web",
    purchaseYear: numberValue(holding.purchaseYear),
    code: String(holding.code ?? ""),
    cost: numberValue(holding.cost),
    units: numberValue(holding.units),
    holdYears: numberValue(holding.holdYears),
  };
}

function readStoredHoldings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setSaveState(message) {
  document.getElementById("save-state").textContent = message;
}

async function persistHoldings() {
  holdings = holdings.map(normalizeHolding);
  if (apiEnabled) {
    const response = await fetch(API_HOLDINGS_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdings }),
    });
    if (!response.ok) {
      throw new Error(`บันทึกไม่สำเร็จ (${response.status})`);
    }
    data = await response.json();
    fundsByCode = new Map((data.funds ?? []).map((fund) => [fund.code, fund]));
    holdings = (data.holdings ?? []).map(normalizeHolding);
    setSaveState("บันทึกลงเว็บไซต์แล้ว");
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  setSaveState("บันทึกไว้ใน browser นี้แล้ว");
}

function seedHoldings() {
  const fallback = apiEnabled ? null : readStoredHoldings();
  holdings = (fallback ?? data.holdings ?? []).map(normalizeHolding);
  setSaveState(apiEnabled ? "บันทึกข้อมูลผ่านเว็บไซต์" : "บันทึกข้อมูลใน browser นี้");
}

function renderFundOptions() {
  const select = document.getElementById("fund-code");
  select.innerHTML = "";
  for (const fund of data.funds ?? []) {
    const option = document.createElement("option");
    option.value = fund.code;
    option.textContent = `${fund.code} - NAV ${formatNav(fund.nav)}`;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    const fund = fundsByCode.get(select.value);
    if (fund?.holdYears != null) {
      document.getElementById("hold-years").value = fund.holdYears;
    }
  });
}

function renderMetrics(calculated) {
  const total = calculated.reduce(
    (acc, holding) => {
      acc.cost += holding.cost;
      acc.currentValue += holding.currentValue;
      acc.gain += holding.gain;
      return acc;
    },
    { cost: 0, currentValue: 0, gain: 0 },
  );

  const latestDate = (data.funds ?? [])
    .map((fund) => fund.navDateDisplay)
    .filter(Boolean)
    .sort()
    .at(-1) ?? "-";

  document.getElementById("total-value").textContent = formatMoney(total.currentValue);
  document.getElementById("total-gain").textContent = formatMoney(total.gain);
  document.getElementById("total-gain").className = total.gain >= 0 ? "positive" : "negative";
  document.getElementById("latest-nav-date").textContent = latestDate;
}

function renderTable() {
  const calculated = holdings.map(calculateHolding);
  const tbody = document.getElementById("holding-table");
  tbody.innerHTML = "";

  if (!calculated.length) {
    tbody.innerHTML = '<tr><td colspan="10">ยังไม่มีข้อมูล</td></tr>';
    renderMetrics(calculated);
    return;
  }

  for (const holding of calculated) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${holding.purchaseYear}</td>
      <td>
        <strong>${escapeHtml(holding.code)}</strong>
        <span>${escapeHtml(holding.nameTh)}</span>
      </td>
      <td>${formatMoney(holding.cost)}</td>
      <td>${formatNav(holding.units)}</td>
      <td>
        ${formatNav(holding.nav)}
        <span>${escapeHtml(holding.navDateDisplay)}</span>
      </td>
      <td>${formatMoney(holding.currentValue)}</td>
      <td class="${holding.gain >= 0 ? "positive" : "negative"}">${formatMoney(holding.gain)}</td>
      <td class="${holding.gain >= 0 ? "positive" : "negative"}">${formatPct(holding.gainPct)}</td>
      <td>${escapeHtml(holding.status)}</td>
      <td><button class="icon-button" type="button" data-delete="${escapeHtml(holding.id)}">ลบ</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      holdings = holdings.filter((holding) => holding.id !== button.dataset.delete);
      try {
        await persistHoldings();
        renderTable();
      } catch (error) {
        setSaveState(error.message);
      }
    });
  });

  renderMetrics(calculated);
}

function fillDefaultForm() {
  const firstFund = data.funds?.[0];
  document.getElementById("purchase-year").value = new Date().getFullYear();
  document.getElementById("fund-code").value = firstFund?.code ?? "";
  document.getElementById("cost").value = "";
  document.getElementById("units").value = "";
  document.getElementById("hold-years").value = firstFund?.holdYears ?? 10;
}

function bindForm() {
  document.getElementById("holding-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    holdings.push({
      id: `web-${Date.now()}`,
      source: "web",
      purchaseYear: Number(form.get("purchaseYear")),
      code: String(form.get("code")),
      cost: Number(form.get("cost")),
      units: Number(form.get("units")),
      holdYears: Number(form.get("holdYears")),
    });
    try {
      await persistHoldings();
      renderTable();
      event.currentTarget.reset();
      fillDefaultForm();
    } catch (error) {
      holdings.pop();
      setSaveState(error.message);
    }
  });
}

async function loadData() {
  try {
    const response = await fetch(API_DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("API unavailable");
    apiEnabled = true;
    return response.json();
  } catch {
    apiEnabled = false;
    const response = await fetch("data.json", { cache: "no-store" });
    return response.json();
  }
}

async function load() {
  data = await loadData();
  fundsByCode = new Map((data.funds ?? []).map((fund) => [fund.code, fund]));
  renderFundOptions();
  seedHoldings();
  bindForm();
  fillDefaultForm();
  renderTable();
}

load().catch((error) => {
  document.getElementById("holding-table").innerHTML = `<tr><td colspan="10">${escapeHtml(error.message)}</td></tr>`;
});
