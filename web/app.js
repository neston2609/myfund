'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const PROFILE_SLUG = location.pathname.split('/').filter(Boolean)[0] || 'eston';
const PROFILE_API  = `/api/profiles/${encodeURIComponent(PROFILE_SLUG)}`;
const API_DATA     = `${PROFILE_API}/data`;
const API_HOLDINGS = `${PROFILE_API}/holdings`;
const API_FUNDS    = `${PROFILE_API}/funds`;
const API_NAV      = `${PROFILE_API}/refresh-nav`;
const API_CATALOG  = '/api/fund-catalog';
const API_DETAIL   = '/api/fund-detail';
const LS_KEY       = `myfund_settings_v1_${PROFILE_SLUG}`;

const PALETTE = ['#f97316','#0ea5e9','#22c55e','#ec4899','#a855f7','#eab308','#06b6d4','#ef4444'];
const THEMES  = {
  coral:  { accent:'#ff6b5e', accent2:'#ffa94d' },
  lagoon: { accent:'#14b8a6', accent2:'#38bdf8' },
  grape:  { accent:'#8b5cf6', accent2:'#ec4899'  },
};

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  funds:    [],   // server fund objects: { code, nameTh, nav, navDateDisplay, holdYears, sourceUrl }
  holdings: [],   // server holding objects: { id, purchaseYear, code, cost, units, ... }
  profile:  { slug: PROFILE_SLUG, name: PROFILE_SLUG },
  theme:    'grape',
  apiBase:  '',   // custom NAV source (optional override)
  navUpdatedAt: null,
  catalog:  null,
  selectedCompany: '',
  selectedCatalogFund: null,
  loading:  false,
  toast:    null,
  toastTimer: null,
  modal:    null, // { kind:'holding'|'fund'|'settings', editId:null|string }
  form:     {},
};

// ── Formatters ────────────────────────────────────────────────────────────
const fmtMoney = new Intl.NumberFormat('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const fmtNav4  = new Intl.NumberFormat('en-US', { minimumFractionDigits:4, maximumFractionDigits:4 });
const fmtPct   = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
const fmt      = (n) => 'THB ' + fmtMoney.format(n || 0);
const fmt4     = (n) => fmtNav4.format(n || 0);
const esc      = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function colorOf(code) {
  const idx = S.funds.findIndex(f => f.code === code);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : 0];
}

// ── Settings persistence ───────────────────────────────────────────────────
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (s.theme && THEMES[s.theme]) S.theme = s.theme;
    if (s.apiBase) S.apiBase = s.apiBase;
    if (s.navUpdatedAt) S.navUpdatedAt = s.navUpdatedAt;
  } catch {}
}
function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      theme: S.theme, apiBase: S.apiBase, navUpdatedAt: S.navUpdatedAt
    }));
  } catch {}
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(name) {
  S.theme = name || 'grape';
  document.body.className = 'theme-' + S.theme;
  document.querySelectorAll('.theme-dot').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === S.theme);
  });
  saveSettings();
}

function renderThemeSwitcher() {
  const el = document.getElementById('theme-switcher');
  el.innerHTML = Object.keys(THEMES).map(k =>
    `<button class="theme-dot${S.theme===k?' active':''}" data-theme="${k}" title="${k}"
      style="background:${THEMES[k].accent};" onclick="applyTheme('${k}')"></button>`
  ).join('');
}
window.applyTheme = applyTheme;

// ── API Helpers ────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Refresh NAV: uses server endpoint (Finnomena) by default;
// falls back to client-side fetch if user set a custom apiBase.
async function doRefreshNav() {
  if (S.loading) return;
  S.loading = true;
  const btn = document.getElementById('btn-refresh-nav');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinning">⟳</span> กำลังอัปเดต…';

  try {
    if (S.apiBase) {
      // Client-side: fetch each fund from custom apiBase
      const updated = await Promise.all(S.funds.map(async f => {
        try {
          const url = S.apiBase.replace('{code}', encodeURIComponent(f.code));
          const j = await fetch(url).then(r => r.json());
          const v = j?.nav ?? j?.last_val ?? null;
          if (v !== null && !isNaN(Number(v))) return { ...f, nav: Number(v) };
        } catch {}
        return f;
      }));
      // Persist funds to server
      const data = await apiFetch(API_FUNDS, { method:'PUT', body: JSON.stringify({ funds: updated }) });
      ingestData(data);
      S.navUpdatedAt = Date.now();
      saveSettings();
      toast('✓ อัปเดต NAV แล้ว · NAV updated');
    } else {
      // Server-side: Finnomena fetch
      const data = await apiFetch(API_NAV, { method:'POST', body:'{}' });
      ingestData(data);
      S.navUpdatedAt = Date.now();
      saveSettings();
      const errors = data.navRefreshErrors || [];
      if (errors.length) {
        toast(`✓ อัปเดต NAV แล้ว · บางกองทุนดึงไม่ได้: ${errors.map(e=>e.code).join(', ')}`, 5000);
      } else {
        toast('✓ อัปเดต NAV ทุกกองทุนแล้ว · All NAV updated');
      }
    }
  } catch (err) {
    toast('ดึง NAV ไม่สำเร็จ · ' + err.message);
  }

  S.loading = false;
  btn.disabled = false;
  btn.textContent = '↻ อัปเดต NAV';
  renderAll();
}

// ── Data ingestion ─────────────────────────────────────────────────────────
function ingestData(data) {
  S.funds    = data.funds    ?? [];
  S.holdings = data.holdings ?? [];
  S.profile  = data.profile  ?? { slug: PROFILE_SLUG, name: PROFILE_SLUG };
  document.querySelectorAll('[data-profile-name]').forEach(el => {
    el.textContent = S.profile.name ?? PROFILE_SLUG;
  });
}

// ── Computed values ────────────────────────────────────────────────────────
function computePortfolio() {
  const cy = new Date().getFullYear();
  const fundMap = new Map(S.funds.map(f => [f.code, f]));

  let totalCost = 0, totalValue = 0;

  const holdings = S.holdings.map(h => {
    const f = fundMap.get(h.code) || {};
    const nav  = Number(f.nav || h.nav || 0);
    const cost  = Number(h.cost  || 0);
    const units = Number(h.units || 0);
    const value = units * nav;
    const pl    = value - cost;
    const plPct = cost ? pl / cost : 0;
    totalCost  += cost;
    totalValue += value;
    const termYears   = Number(h.holdYears || f.holdYears || 0);
    const maturityYear = Number(h.purchaseYear || 0) + termYears;
    const matured      = cy >= maturityYear;
    const yearsLeft    = Math.max(0, maturityYear - cy);
    const lockPct      = termYears ? Math.min(100, Math.max(0, (cy - Number(h.purchaseYear)) / termYears * 100)) : 0;

    return {
      id: h.id, year: h.purchaseYear, code: h.code, color: colorOf(h.code),
      cost, units, nav, value, pl, plPct,
      costStr:  fmt(cost),  unitsStr: fmt4(units),
      navStr:   fmt4(nav),  valueStr: fmt(value),
      plStr:    (pl >= 0 ? '+' : '') + fmt(pl),
      plPctStr: fmtPct(plPct),
      plColor:  pl >= 0 ? 'var(--pos)' : 'var(--neg)',
      lockPct, maturityYear, matured, yearsLeft,
      statusLabel: matured
        ? `ครบกำหนด Matured · ${maturityYear}`
        : `ครบปี ${maturityYear} · เหลือ ${yearsLeft} ปี`,
      statusColor: matured ? 'var(--pos)' : 'var(--muted)',
    };
  });

  // Sort newest first
  holdings.sort((a, b) => b.year - a.year || a.code.localeCompare(b.code));

  const totalPL    = totalValue - totalCost;
  const totalPLPct = totalCost ? totalPL / totalCost : 0;

  // Fund summaries
  const funds = S.funds.map(f => {
    const hs    = S.holdings.filter(h => h.code === f.code);
    const cost  = hs.reduce((s, h) => s + Number(h.cost  || 0), 0);
    const units = hs.reduce((s, h) => s + Number(h.units || 0), 0);
    const value = units * Number(f.nav || 0);
    const pl    = value - cost;
    const plPct = cost ? pl / cost : 0;
    return {
      code: f.code, type: f.type || 'Fund',
      sourceUrl: f.sourceUrl || `https://www.finnomena.com/fund/${encodeURIComponent(f.code)}`,
      color: colorOf(f.code),
      nav: Number(f.nav || 0), navStr: fmt4(f.nav),
      termYears: Number(f.holdYears || 0),
      cost, value, pl, plPct,
      costStr:  fmt(cost),  valueStr: fmt(value),
      units, unitsStr: fmt4(units),
      plStr:    (pl >= 0 ? '+' : '') + fmt(pl),
      plPctStr: fmtPct(plPct),
      plColor:  pl >= 0 ? 'var(--pos)' : 'var(--neg)',
      lots: hs.length,
    };
  });

  // Pie chart
  let acc = 0;
  const stops = funds.map(f => {
    const share = totalValue ? f.value / totalValue * 100 : 0;
    const start = acc; acc += share;
    return `${f.color} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
  });
  const pieGradient = stops.length
    ? `conic-gradient(${stops.join(',')})`
    : 'var(--surface2)';

  // Bar chart by year
  const byYear = {};
  S.holdings.forEach(h => {
    const f = fundMap.get(h.code) || {};
    const yr = Number(h.purchaseYear);
    if (!byYear[yr]) byYear[yr] = { year: yr, cost: 0, value: 0 };
    byYear[yr].cost  += Number(h.cost  || 0);
    byYear[yr].value += Number(h.units || 0) * Number(f.nav || 0);
  });
  const years  = Object.values(byYear).sort((a, b) => a.year - b.year);
  const maxV   = Math.max(1, ...years.map(y => Math.max(y.cost, y.value)));
  const yearBars = years.map(y => ({
    year: y.year, costStr: fmt(y.cost), valueStr: fmt(y.value),
    costH:  Math.round(y.cost  / maxV * 150),
    valueH: Math.round(y.value / maxV * 150),
  }));

  return { holdings, funds, totalCost, totalValue, totalPL, totalPLPct, pieGradient, yearBars };
}

// ── Render functions ───────────────────────────────────────────────────────
function renderHero(p) {
  const sign = p.totalPL >= 0 ? '+' : '';
  document.getElementById('hero-value').textContent = fmt(p.totalValue);
  document.getElementById('hero-pl').textContent =
    `${sign}${fmt(p.totalPL)} · ${sign}${(p.totalPLPct * 100).toFixed(2)}%`;
  document.getElementById('hero-cost').textContent = `ต้นทุนรวม Cost ${fmt(p.totalCost)}`;
  document.getElementById('hero-lots').textContent  = S.holdings.length;
  document.getElementById('hero-funds').textContent = S.funds.length;
  document.getElementById('hero-nav-status').textContent = S.navUpdatedAt
    ? 'NAV: ' + new Date(S.navUpdatedAt).toLocaleString('th-TH')
    : 'ยังไม่ได้อัปเดต NAV · NAV not refreshed yet';
}

function renderCharts(p) {
  // Pie
  document.getElementById('pie-chart').style.background = p.pieGradient;
  document.getElementById('pie-count').textContent = S.funds.length;
  const legend = document.getElementById('legend');
  const totalValue = p.totalValue || 1;
  legend.innerHTML = p.funds.map(f =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${f.color};"></span>
      <span class="legend-code">${esc(f.code)}</span>
      <span class="legend-pct">${(f.value / totalValue * 100).toFixed(1)}%</span>
    </div>`
  ).join('');

  // Bar chart
  const bc = document.getElementById('bar-chart');
  if (!p.yearBars.length) {
    bc.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;">ยังไม่มีข้อมูล</div>';
    return;
  }
  bc.innerHTML = p.yearBars.map(y =>
    `<div class="bar-year">
      <div class="bar-pair">
        <div class="bar-cost" title="${y.costStr}"  style="height:${y.costH}px;"></div>
        <div class="bar-val"  title="${y.valueStr}" style="height:${y.valueH}px;"></div>
      </div>
      <div class="bar-label">${y.year}</div>
    </div>`
  ).join('');
}

function renderFundCards(p) {
  const el = document.getElementById('fund-cards');
  if (!p.funds.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:14px;">ยังไม่มีกองทุน — กด "+ เพิ่มกองทุน"</div>';
    return;
  }
  el.innerHTML = p.funds.map(f =>
    `<div class="fund-card">
      <div class="fund-card-head">
        <span class="fund-color-dot" style="background:${f.color};"></span>
        <a class="fund-code fund-code-link" href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="เปิดรายละเอียดกองทุน · Open fund details">${esc(f.code)}</a>
        <span class="fund-type-badge">${esc(f.type)}</span>
      </div>
      <div class="fund-stats">
        <div><div class="fund-stat-label">มูลค่า Value</div><div class="fund-stat-val">${f.valueStr}</div></div>
        <div style="text-align:right;"><div class="fund-stat-label">NAV</div><div class="fund-stat-val">${f.navStr}</div></div>
      </div>
      <div class="fund-unit-row">
        <span>จำนวนหน่วยรวม · Total units</span>
        <strong>${f.unitsStr}</strong>
      </div>
      <div class="fund-pl-row">
        <span class="fund-pl" style="color:${f.plColor};">${f.plStr} <span class="fund-pl-pct">(${f.plPctStr})</span></span>
        <div class="fund-actions">
          <button class="btn-ghost" onclick="openFund('${esc(f.code)}')" title="แก้ไข Edit">✎</button>
          <button class="btn-ghost danger" onclick="deleteFund('${esc(f.code)}')" title="ลบ Delete">✕</button>
        </div>
      </div>
      <div class="fund-meta">${f.lots} lots · ต้นทุน ${f.costStr} · ล็อก ${f.termYears} ปี</div>
    </div>`
  ).join('');
}

function renderHoldingsTable(p) {
  const el = document.getElementById('holdings-body');
  if (!p.holdings.length) {
    el.innerHTML = '<div class="empty-row">ยังไม่มีรายการ — กด "+ เพิ่มรายการซื้อ"</div>';
    return;
  }
  el.innerHTML = p.holdings.map(h =>
    `<div class="td-row">
      <div class="td-year">${h.year}</div>
      <div class="td-fund">
        <span class="td-fund-dot" style="background:${h.color};"></span>
        <span class="td-fund-code" title="${esc(h.code)}">${esc(h.code)}</span>
      </div>
      <div class="ta-r">${h.costStr}</div>
      <div class="ta-r" style="color:var(--muted);">${h.unitsStr}</div>
      <div class="ta-r">${h.navStr}</div>
      <div class="ta-r" style="font-weight:600;">${h.valueStr}</div>
      <div class="ta-r td-pl" style="color:${h.plColor};">${h.plStr}<div class="td-pl-pct">${h.plPctStr}</div></div>
      <div>
        <div class="maturity-label" style="color:${h.statusColor};">${h.statusLabel}</div>
        <div class="maturity-bar-bg"><div class="maturity-bar-fill" style="width:${h.lockPct.toFixed(0)}%;"></div></div>
      </div>
      <div class="td-actions">
        <button class="btn-ghost" onclick="openHolding('${esc(h.id)}')" title="แก้ไข Edit">✎</button>
        <button class="btn-ghost danger" onclick="deleteHolding('${esc(h.id)}')" title="ลบ Delete">✕</button>
      </div>
    </div>`
  ).join('');
}

function renderAll() {
  const p = computePortfolio();
  renderHero(p);
  renderCharts(p);
  renderFundCards(p);
  renderHoldingsTable(p);
}

// ── Modal helpers ──────────────────────────────────────────────────────────
function openModal(title, bodyHtml, footHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML  = bodyHtml;
  document.getElementById('modal-foot').innerHTML  = footHtml;
  document.getElementById('modal-backdrop').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  S.modal = null;
  S.form  = {};
}
window.closeModal = closeModal;

function getFormValues(ids) {
  const out = {};
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) out[id] = el.value;
  });
  return out;
}

// ── Holding modal ──────────────────────────────────────────────────────────
window.openHolding = function(id) {
  S.modal = { kind: 'holding', editId: id || null };
  const cy = new Date().getFullYear();
  let year = cy, code = S.funds[0]?.code || '', cost = '', units = '';

  if (id) {
    const h = S.holdings.find(x => x.id === id);
    if (h) { year = h.purchaseYear; code = h.code; cost = h.cost; units = h.units; }
  }

  const fundOpts = S.funds.map(f => `<option value="${esc(f.code)}"${f.code===code?' selected':''}>${esc(f.code)}</option>`).join('');
  const title = id ? 'แก้ไขรายการ · Edit holding' : 'เพิ่มรายการซื้อ · Add holding';

  openModal(title,
    `<div class="field-row">
      <div class="field"><label>ปีที่ซื้อ · Year</label><input id="f-year" type="number" value="${year}" min="1900" max="2200"></div>
      <div class="field"><label>กองทุน · Fund</label><select id="f-code">${fundOpts}</select></div>
    </div>
    <div class="field"><label>ต้นทุน (บาท) · Cost (THB)</label><input id="f-cost" type="number" value="${cost}" placeholder="70000" min="0" step="0.01"></div>
    <div class="field"><label>จำนวนหน่วย · Units</label><input id="f-units" type="number" value="${units}" placeholder="7389.3445" min="0" step="0.0001"></div>
    <div class="field-hint">มูลค่าปัจจุบัน = หน่วย × NAV ของกองทุน · Current value = units × fund NAV.</div>`,
    `${id ? '<button class="btn-danger" onclick="deleteHoldingFromModal()">ลบ Delete</button>' : ''}
    <div class="modal-foot-right">
      <button class="btn-cancel" onclick="closeModal()">ยกเลิก Cancel</button>
      <button class="btn-save" onclick="saveHolding()">บันทึก Save</button>
    </div>`
  );
};
window.openHolding = window.openHolding;

window.saveHolding = async function() {
  const v = getFormValues(['f-year','f-code','f-cost','f-units']);
  if (!v['f-code'] || !v['f-cost'] || !v['f-units']) { toast('กรอกข้อมูลให้ครบ · Fill all fields'); return; }

  const rec = {
    id:           S.modal.editId || ('web-' + Date.now()),
    source:       'web',
    purchaseYear: parseInt(v['f-year']) || new Date().getFullYear(),
    code:         v['f-code'],
    cost:         parseFloat(v['f-cost']) || 0,
    units:        parseFloat(v['f-units']) || 0,
  };

  const holdings = S.modal.editId
    ? S.holdings.map(h => h.id === S.modal.editId ? rec : h)
    : [...S.holdings, rec];

  try {
    const data = await apiFetch(API_HOLDINGS, { method:'PUT', body: JSON.stringify({ holdings }) });
    ingestData(data);
    closeModal();
    renderAll();
    toast(S.modal ? '✓ บันทึกแล้ว Saved' : '✓ เพิ่มรายการแล้ว Added');
  } catch (err) {
    toast('บันทึกไม่สำเร็จ · ' + err.message);
  }
};

window.deleteHoldingFromModal = function() {
  if (!confirm('ลบรายการนี้? · Delete this holding?')) return;
  const id = S.modal.editId;
  closeModal();
  deleteHolding(id);
};

window.deleteHolding = async function(id) {
  if (!confirm('ลบรายการนี้? · Delete this holding?')) return;
  const holdings = S.holdings.filter(h => h.id !== id);
  try {
    const data = await apiFetch(API_HOLDINGS, { method:'PUT', body: JSON.stringify({ holdings }) });
    ingestData(data);
    renderAll();
    toast('✓ ลบรายการแล้ว Deleted');
  } catch (err) {
    toast('ลบไม่สำเร็จ · ' + err.message);
  }
};

// ── Fund modal ─────────────────────────────────────────────────────────────
async function ensureCatalog() {
  if (S.catalog) return S.catalog;
  S.catalog = await apiFetch(API_CATALOG);
  return S.catalog;
}

function compactFundName(fund) {
  return `${fund.code} · ${fund.nameTh || ''}`.trim();
}

function renderCompanyResults() {
  const q = (document.getElementById('f-company-search')?.value || '').trim().toLowerCase();
  const list = (S.catalog?.companies ?? [])
    .filter(company => !q || company.name.toLowerCase().includes(q))
    .slice(0, 40);
  const el = document.getElementById('company-results');
  if (!el) return;
  el.innerHTML = list.map(company =>
    `<button class="pick-row${S.selectedCompany===company.name?' active':''}" type="button" onclick="selectCompany('${encodeURIComponent(company.name)}')">
      <span>${esc(company.name)}</span>
      <small>${company.count} funds</small>
    </button>`
  ).join('') || '<div class="pick-empty">ไม่พบบริษัท · No company found</div>';
}

function renderFundResults() {
  const q = (document.getElementById('f-fund-search')?.value || '').trim().toLowerCase();
  const funds = (S.catalog?.funds ?? [])
    .filter(fund => !S.selectedCompany || fund.company === S.selectedCompany)
    .filter(fund => !q || fund.searchText.includes(q))
    .slice(0, 80);
  const el = document.getElementById('fund-results');
  if (!el) return;
  el.innerHTML = funds.map(fund =>
    `<button class="pick-row${S.selectedCatalogFund?.id===fund.id?' active':''}" type="button" onclick="selectCatalogFund('${encodeURIComponent(fund.id)}')">
      <span><b>${esc(fund.code)}</b> ${esc(fund.nameTh)}</span>
      <small>${esc(fund.company)}</small>
    </button>`
  ).join('') || '<div class="pick-empty">ไม่พบกองทุน · No fund found</div>';
}

window.renderCompanyResults = renderCompanyResults;
window.renderFundResults = renderFundResults;

window.selectCompany = function(companyParam) {
  const company = decodeURIComponent(companyParam);
  S.selectedCompany = company;
  S.selectedCatalogFund = null;
  const fundSearch = document.getElementById('f-fund-search');
  if (fundSearch) fundSearch.value = '';
  const selected = document.getElementById('selected-company-label');
  if (selected) selected.textContent = company || 'ทุกบริษัท · All companies';
  const selectedFund = document.getElementById('selected-fund-label');
  if (selectedFund) selectedFund.textContent = 'ยังไม่ได้เลือกกองทุน · No fund selected';
  renderCompanyResults();
  renderFundResults();
};

window.selectCatalogFund = function(idParam) {
  const id = decodeURIComponent(idParam);
  const fund = (S.catalog?.funds ?? []).find(item => item.id === id);
  if (!fund) return;
  S.selectedCatalogFund = fund;
  const selectedFund = document.getElementById('selected-fund-label');
  if (selectedFund) selectedFund.textContent = compactFundName(fund);
  renderFundResults();
};

window.setFundMode = function(mode) {
  document.querySelectorAll('[data-fund-mode-panel]').forEach(panel => {
    panel.style.display = panel.dataset.fundModePanel === mode ? 'flex' : 'none';
  });
  document.querySelectorAll('[data-fund-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.fundMode === mode);
  });
  const modeInput = document.getElementById('f-mode');
  if (modeInput) modeInput.value = mode;
};

window.openFund = function(code) {
  S.modal = { kind: 'fund', editId: code || null };
  let fcode = '', type = 'SSF', nav = '', termYears = '10';

  if (code) {
    const f = S.funds.find(x => x.code === code);
    if (f) { fcode = f.code; type = f.type || 'SSF'; nav = f.nav; termYears = f.holdYears; }
  }

  const typeOpts = ['SSF','ThaiESG','RMF','Other'].map(t =>
    `<option value="${t}"${type===t?' selected':''}>${t}</option>`).join('');

  const title = code ? 'แก้ไขกองทุน · Edit fund' : 'เพิ่มกองทุน · Add fund';
  const readonly = code ? 'readonly style="opacity:.6;cursor:not-allowed;"' : '';

  openModal(title,
    `${code ? '' : `<input id="f-mode" type="hidden" value="list">
    <div class="segmented">
      <button class="active" data-fund-mode="list" type="button" onclick="setFundMode('list')">เลือกจาก List</button>
      <button data-fund-mode="manual" type="button" onclick="setFundMode('manual')">กรอกเอง</button>
    </div>`}
    <div class="fund-picker" data-fund-mode-panel="list" style="${code ? 'display:none;' : ''}">
      <div class="field"><label>ค้นหาบริษัทกองทุน · Search asset manager</label><input id="f-company-search" type="search" placeholder="SCBAM, KTAM, KAsset" oninput="renderCompanyResults()"></div>
      <div class="pick-list compact" id="company-results"><div class="pick-empty">กำลังโหลด · Loading</div></div>
      <div class="selected-pill" id="selected-company-label">ทุกบริษัท · All companies</div>
      <div class="field"><label>ค้นหาชื่อ/รหัสกองทุน · Search fund</label><input id="f-fund-search" type="search" placeholder="SCBTP, ThaiESG, กองทุน" oninput="renderFundResults()"></div>
      <div class="pick-list" id="fund-results"><div class="pick-empty">กำลังโหลด · Loading</div></div>
      <div class="selected-pill" id="selected-fund-label">ยังไม่ได้เลือกกองทุน · No fund selected</div>
    </div>
    <div class="manual-fund-fields" data-fund-mode-panel="manual" style="${code ? 'display:flex;' : 'display:none;'}">
      <div class="field"><label>ชื่อ/รหัสกองทุน · Fund name/code</label><input id="f-fcode" type="text" value="${esc(fcode)}" placeholder="SCBTP(ThaiESG)" ${readonly}></div>
      <div class="field-row">
        <div class="field"><label>ประเภท · Type</label><select id="f-type">${typeOpts}</select></div>
        <div class="field"><label>ระยะที่ต้องถือครอง (ปี) · Term (yrs)</label><input id="f-term" type="number" value="${termYears}" min="0" max="100"></div>
      </div>
      <div class="field"><label>NAV ล่าสุด · Current NAV</label><input id="f-nav" type="number" value="${nav}" placeholder="11.3154" step="0.0001"></div>
    </div>`,
    `${code ? '<button class="btn-danger" onclick="deleteFundFromModal()">ลบ Delete</button>' : ''}
    <div class="modal-foot-right">
      <button class="btn-cancel" onclick="closeModal()">ยกเลิก Cancel</button>
      <button class="btn-save" onclick="saveFund()">บันทึก Save</button>
    </div>`
  );

  if (!code) {
    S.selectedCompany = '';
    S.selectedCatalogFund = null;
    ensureCatalog()
      .then(() => { renderCompanyResults(); renderFundResults(); })
      .catch(err => {
        document.getElementById('company-results').innerHTML = `<div class="pick-empty">โหลดรายชื่อไม่ได้ · ${esc(err.message)}</div>`;
        document.getElementById('fund-results').innerHTML = `<div class="pick-empty">โหลดรายชื่อไม่ได้ · ${esc(err.message)}</div>`;
      });
  }
};

window.saveFund = async function() {
  const isEdit = !!S.modal.editId;
  const mode = document.getElementById('f-mode')?.value || 'manual';
  let rec;

  try {
    if (!isEdit && mode === 'list') {
      if (!S.selectedCatalogFund) { toast('เลือกกองทุนก่อน · Select a fund'); return; }
      const detail = await apiFetch(`${API_DETAIL}?id=${encodeURIComponent(S.selectedCatalogFund.id)}`);
      rec = {
        code: detail.code,
        nameTh: detail.nameTh,
        company: detail.company,
        category: detail.category,
        type: detail.type || 'Fund',
        nav: Number(detail.nav || 0),
        navDate: detail.navDate,
        navDateDisplay: detail.navDateDisplay,
        holdYears: detail.holdYears ?? 0,
        sourceUrl: detail.sourceUrl,
      };
    } else {
      const v = getFormValues(['f-fcode','f-type','f-term','f-nav']);
      if (!v['f-fcode'] || v['f-nav'] === '') { toast('กรอกชื่อและ NAV · Name & NAV required'); return; }
      rec = {
        code:         v['f-fcode'].trim(),
        nameTh:       v['f-fcode'].trim(),
        type:         v['f-type'] || 'SSF',
        nav:          parseFloat(v['f-nav']) || 0,
        holdYears:    parseInt(v['f-term']) || 0,
        navDateDisplay: isEdit ? (S.funds.find(f=>f.code===S.modal.editId)?.navDateDisplay || '') : '',
        sourceUrl:    `https://www.finnomena.com/fund/${encodeURIComponent(v['f-fcode'].trim())}`,
      };
    }
  } catch (err) {
    toast('ดึงข้อมูลกองทุนไม่สำเร็จ · ' + err.message);
    return;
  }

  if (!isEdit && S.funds.some(f => f.code === rec.code)) {
    toast('มีกองทุนนี้อยู่แล้ว · Fund already exists');
    return;
  }

  const funds = isEdit
    ? S.funds.map(f => f.code === S.modal.editId ? { ...f, ...rec, code: f.code } : f)
    : [...S.funds, rec];

  try {
    const data = await apiFetch(API_FUNDS, { method:'PUT', body: JSON.stringify({ funds }) });
    ingestData(data);
    closeModal();
    renderAll();
    toast(isEdit ? '✓ บันทึกแล้ว Saved' : '✓ เพิ่มกองทุนแล้ว Added');
  } catch (err) {
    toast('บันทึกไม่สำเร็จ · ' + err.message);
  }
};

window.deleteFundFromModal = function() {
  const code = S.modal.editId;
  closeModal();
  deleteFund(code);
};

window.deleteFund = async function(code) {
  if (S.holdings.some(h => h.code === code)) {
    toast('ลบรายการของกองทุนนี้ก่อน · Remove its holdings first');
    return;
  }
  if (!confirm(`ลบกองทุน ${code}? · Delete this fund?`)) return;
  const funds = S.funds.filter(f => f.code !== code);
  try {
    const data = await apiFetch(API_FUNDS, { method:'PUT', body: JSON.stringify({ funds }) });
    ingestData(data);
    renderAll();
    toast('✓ ลบกองทุนแล้ว Fund deleted');
  } catch (err) {
    toast('ลบไม่สำเร็จ · ' + err.message);
  }
};

// ── Settings modal ─────────────────────────────────────────────────────────
function openSettings() {
  S.modal = { kind: 'settings' };
  const activeSource = S.apiBase
    ? S.apiBase
    : 'https://www.finnomena.com/ (ค่าเริ่มต้น · default)';
  openModal('แหล่งข้อมูล NAV · NAV data source',
    `<div class="field-hint" style="display:flex;flex-direction:column;gap:4px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;">แหล่งข้อมูลที่ใช้อยู่ · Active source</div>
      <div style="font-size:13px;font-weight:600;word-break:break-all;">${esc(activeSource)}</div>
    </div>
    <div class="field"><label>Custom NAV API URL (optional)</label>
      <input id="f-apibase" type="text" value="${esc(S.apiBase)}" placeholder="https://your-api.com/nav?fund={code}">
    </div>
    <div class="field-hint">
      ใส่ <b>{code}</b> ตรงตำแหน่งรหัสกองทุน เช่น <code style="background:var(--bg);padding:1px 5px;border-radius:5px;">{"nav": 11.32}</code><br>
      หากเว้นว่าง จะดึง NAV จาก <b>Finnomena</b> โดยอัตโนมัติผ่าน server<br>
      Use <b>{code}</b> as fund code placeholder. Leave blank to use built-in Finnomena source.
    </div>`,
    `<div class="modal-foot-right">
      <button class="btn-cancel" onclick="closeModal()">ยกเลิก Cancel</button>
      <button class="btn-save" onclick="saveSettings2()">บันทึก Save</button>
    </div>`
  );
}

window.saveSettings2 = function() {
  const v = getFormValues(['f-apibase']);
  S.apiBase = (v['f-apibase'] || '').trim();
  saveSettings();
  closeModal();
  toast('✓ บันทึกการตั้งค่า Settings saved');
};

// ── Export CSV ─────────────────────────────────────────────────────────────
function exportCsv() {
  const cy = new Date().getFullYear();
  const fundMap = new Map(S.funds.map(f => [f.code, f]));
  const head = ['Year','Fund','Type','Cost','Units','NAV','CurrentValue','PL','PLpct','MaturityYear','Status'];
  const lines = [head.join(',')];

  [...S.holdings].sort((a,b) => b.purchaseYear - a.purchaseYear).forEach(h => {
    const f     = fundMap.get(h.code) || {};
    const value = Number(h.units||0) * Number(f.nav||0);
    const pl    = value - Number(h.cost||0);
    const plp   = h.cost ? pl / h.cost * 100 : 0;
    const my    = Number(h.purchaseYear||0) + Number(f.holdYears||h.holdYears||0);
    lines.push([
      h.purchaseYear, `"${(f.code||h.code||'')}"`, f.type||'',
      h.cost, h.units, f.nav||'', value.toFixed(2),
      pl.toFixed(2), plp.toFixed(2)+'%', my, cy>=my?'Matured':'Locked'
    ].join(','));
  });

  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `MyFund_${cy}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('✓ ส่งออก CSV แล้ว Exported');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  applyTheme(S.theme);
  renderThemeSwitcher();

  // Wire buttons
  document.getElementById('btn-refresh-nav').addEventListener('click', doRefreshNav);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-add-holding').addEventListener('click',  () => openHolding(null));
  document.getElementById('btn-add-holding2').addEventListener('click', () => openHolding(null));
  document.getElementById('btn-add-fund').addEventListener('click',  () => openFund(null));
  document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

  // Close modal on backdrop click
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-backdrop')) closeModal();
  });
  document.getElementById('modal-close').addEventListener('click', closeModal);

  // Load initial data
  try {
    const data = await apiFetch(API_DATA);
    ingestData(data);
    renderAll();
  } catch (err) {
    document.getElementById('holdings-body').innerHTML =
      `<div class="empty-row">โหลดข้อมูลไม่ได้ · ${err.message}</div>`;
    return;
  }

  // Real-time NAV: refresh on every page load
  doRefreshNav();
}

init();
