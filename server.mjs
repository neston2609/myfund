import { createServer } from "node:http";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(rootDir, "web");
const legacyDataPath = path.join(webDir, "data.json");
const profilesDir = path.join(rootDir, "profiles");
const profileInitMarker = path.join(profilesDir, ".initialized");
const adminPath = path.join(rootDir, "admin.json");
const smtpPath = path.join(rootDir, "smtp.json");
const defaultProfileSlug = "eston";
const defaultAdminPassword = "Admin123!";
const port = Number(process.env.PORT ?? 8010);
const catalogTtlMs = 6 * 60 * 60 * 1000;
let catalogCache = null;

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

function slugifyProfile(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0E00-\u0E7F]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function profilePath(slug) {
  const safeSlug = slugifyProfile(slug);
  if (!safeSlug) throw new Error("Invalid profile slug");
  return path.join(profilesDir, `${safeSlug}.json`);
}

function blankProfileData(slug, name = slug) {
  return calculateData({
    updatedAt: new Date().toISOString(),
    source: "https://www.finnomena.com/",
    profile: { slug, name },
    funds: [],
    holdings: [],
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureProfileStore() {
  await fs.mkdir(profilesDir, { recursive: true });
  const profileFiles = (await fs.readdir(profilesDir)).filter((file) => file.endsWith(".json"));
  if (profileFiles.length) return;
  if (await fileExists(profileInitMarker)) return;

  const defaultPath = profilePath(defaultProfileSlug);

  let initialData = null;
  if (await fileExists(legacyDataPath)) {
    initialData = JSON.parse(await fs.readFile(legacyDataPath, "utf8"));
  }
  const next = calculateData({
    ...(initialData ?? blankProfileData(defaultProfileSlug)),
    profile: { slug: defaultProfileSlug, name: defaultProfileSlug },
  });
  delete next.rows;
  await fs.writeFile(defaultPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.writeFile(profileInitMarker, new Date().toISOString(), "utf8");
}

async function readData(slug = defaultProfileSlug) {
  await ensureProfileStore();
  const safeSlug = slugifyProfile(slug || defaultProfileSlug);
  const data = JSON.parse(await fs.readFile(profilePath(safeSlug), "utf8"));
  return {
    ...data,
    profile: {
      slug: safeSlug,
      name: data.profile?.name ?? safeSlug,
    },
  };
}

async function writeData(data, slug = defaultProfileSlug) {
  await ensureProfileStore();
  const safeSlug = slugifyProfile(slug || data.profile?.slug || defaultProfileSlug);
  const next = {
    ...data,
    profile: {
      slug: safeSlug,
      name: data.profile?.name ?? safeSlug,
    },
  };
  await fs.writeFile(profilePath(safeSlug), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.writeFile(profileInitMarker, new Date().toISOString(), "utf8");
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

async function listProfiles() {
  await ensureProfileStore();
  const files = (await fs.readdir(profilesDir)).filter((file) => file.endsWith(".json"));
  const profiles = [];
  for (const file of files) {
    const slug = path.basename(file, ".json");
    const data = calculateData(await readData(slug));
    profiles.push({
      slug,
      name: data.profile?.name ?? slug,
      funds: data.funds?.length ?? 0,
      holdings: data.holdings?.length ?? 0,
      portfolioTotals: data.portfolioTotals,
      updatedAt: data.updatedAt ?? null,
      url: `/${encodeURIComponent(slug)}`,
    });
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

async function createProfile({ name, slug }) {
  await ensureProfileStore();
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("Profile name is required");

  const baseSlug = slugifyProfile(slug || cleanName);
  if (!baseSlug) throw new Error("Profile slug is invalid");

  let candidate = baseSlug;
  let index = 2;
  while (await fileExists(profilePath(candidate))) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }

  const data = blankProfileData(candidate, cleanName);
  await writeData(data, candidate);
  return {
    slug: candidate,
    name: cleanName,
    funds: 0,
    holdings: 0,
    portfolioTotals: data.portfolioTotals,
    updatedAt: data.updatedAt,
    url: `/${encodeURIComponent(candidate)}`,
  };
}

async function renameProfile(oldSlug, { name, slug }) {
  await ensureProfileStore();
  const currentSlug = slugifyProfile(oldSlug);
  const cleanName = String(name ?? "").trim();
  if (!currentSlug) throw new Error("Current profile slug is invalid");
  if (!cleanName) throw new Error("Profile name is required");

  const nextSlug = slugifyProfile(slug || cleanName);
  if (!nextSlug) throw new Error("New profile slug is invalid");

  const currentPath = profilePath(currentSlug);
  if (!(await fileExists(currentPath))) throw new Error(`Profile not found: ${currentSlug}`);

  const nextPath = profilePath(nextSlug);
  if (nextSlug !== currentSlug && await fileExists(nextPath)) {
    throw new Error(`Profile already exists: ${nextSlug}`);
  }

  const currentData = JSON.parse(await fs.readFile(currentPath, "utf8"));
  const nextData = calculateData({
    ...currentData,
    updatedAt: new Date().toISOString(),
    profile: { slug: nextSlug, name: cleanName },
  });
  delete nextData.rows;

  await fs.writeFile(nextPath, `${JSON.stringify(nextData, null, 2)}\n`, "utf8");
  if (nextSlug !== currentSlug) await fs.unlink(currentPath);

  return {
    slug: nextSlug,
    name: cleanName,
    funds: nextData.funds?.length ?? 0,
    holdings: nextData.holdings?.length ?? 0,
    portfolioTotals: nextData.portfolioTotals,
    updatedAt: nextData.updatedAt,
    url: `/${encodeURIComponent(nextSlug)}`,
  };
}

function makeHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hashPassword(password, salt = randomBytes(16).toString("hex"), iterations = 120000) {
  const hash = pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return { salt, iterations, hash };
}

async function ensureAdminStore() {
  if (await fileExists(adminPath)) return;
  const credential = hashPassword(defaultAdminPassword);
  await fs.writeFile(adminPath, `${JSON.stringify({ ...credential, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function verifyAdminPassword(password) {
  await ensureAdminStore();
  const credential = JSON.parse(await fs.readFile(adminPath, "utf8"));
  const candidate = pbkdf2Sync(String(password ?? ""), credential.salt, credential.iterations, 32, "sha256");
  const expected = Buffer.from(credential.hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function requireAdmin(password) {
  if (!(await verifyAdminPassword(password))) {
    throw makeHttpError("Invalid admin password", 401);
  }
}

async function changeAdminPassword({ password, newPassword }) {
  await requireAdmin(password);
  const cleanNewPassword = String(newPassword ?? "");
  if (cleanNewPassword.length < 8) throw makeHttpError("New password must be at least 8 characters", 400);
  const credential = hashPassword(cleanNewPassword);
  await fs.writeFile(adminPath, `${JSON.stringify({ ...credential, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { ok: true };
}

async function deleteProfile(slug) {
  await ensureProfileStore();
  const safeSlug = slugifyProfile(slug);
  if (!safeSlug) throw makeHttpError("Profile slug is invalid", 400);
  const target = profilePath(safeSlug);
  if (!(await fileExists(target))) throw makeHttpError(`Profile not found: ${safeSlug}`, 404);
  await fs.unlink(target);
  return { ok: true, slug: safeSlug };
}

function defaultSmtpConfig() {
  return {
    enabled: false,
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "",
    password: "",
    from: "",
    updatedAt: new Date().toISOString(),
  };
}

async function ensureSmtpStore() {
  if (await fileExists(smtpPath)) return;
  await fs.writeFile(smtpPath, `${JSON.stringify(defaultSmtpConfig(), null, 2)}\n`, "utf8");
}

async function readSmtpConfig() {
  await ensureSmtpStore();
  return { ...defaultSmtpConfig(), ...JSON.parse(await fs.readFile(smtpPath, "utf8")) };
}

function publicSmtpConfig(config) {
  const { password, ...safeConfig } = config;
  return { ...safeConfig, hasPassword: Boolean(password) };
}

async function saveSmtpConfig({ password, smtp }) {
  await requireAdmin(password);
  const current = await readSmtpConfig();
  const next = {
    ...current,
    enabled: Boolean(smtp?.enabled),
    host: String(smtp?.host ?? current.host).trim() || "smtp.gmail.com",
    port: Number(smtp?.port ?? current.port) || 587,
    secure: Boolean(smtp?.secure),
    user: String(smtp?.user ?? "").trim(),
    from: String(smtp?.from ?? "").trim(),
    password: smtp?.password ? String(smtp.password) : current.password,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(smtpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return publicSmtpConfig(next);
}

function encodeHeader(value) {
  return String(value ?? "").replace(/\r|\n/g, " ").trim();
}

function dotStuff(body) {
  return String(body ?? "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function createSmtpSession(socket) {
  let stream = socket;
  let buffer = "";
  const waiters = [];

  function attach(nextStream) {
    stream = nextStream;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      drain();
    });
    stream.on("error", (error) => {
      while (waiters.length) waiters.shift().reject(error);
    });
  }

  function drain() {
    while (waiters.length) {
      const match = buffer.match(/(?:^|\r?\n)(\d{3}) [^\r\n]*(?:\r?\n|$)/);
      if (!match) return;
      const end = match.index + match[0].length;
      const response = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end);
      waiters.shift().resolve(response);
    }
  }

  function read() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      drain();
    });
  }

  async function command(line, expectedCodes) {
    stream.write(`${line}\r\n`);
    const response = await read();
    const code = Number(response.slice(0, 3));
    if (!expectedCodes.includes(code)) throw new Error(response);
    return response;
  }

  attach(stream);
  return {
    get stream() { return stream; },
    setStream(nextStream) {
      buffer = "";
      attach(nextStream);
    },
    read,
    command,
    end() { stream.end(); },
  };
}

async function connectSocket(config) {
  const options = { host: config.host, port: Number(config.port), servername: config.host };
  const socket = config.secure
    ? tls.connect(options)
    : net.connect(options);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    socket.setTimeout(20000, () => reject(new Error("SMTP connection timed out")));
  });
  return socket;
}

async function sendSmtpMail({ to, subject, text }) {
  const config = await readSmtpConfig();
  if (!config.enabled) throw makeHttpError("SMTP is not enabled", 400);
  if (!config.host || !config.port || !config.user || !config.password) {
    throw makeHttpError("SMTP host, port, username, and password are required", 400);
  }
  const recipient = String(to ?? "").trim();
  if (!recipient) throw makeHttpError("Recipient email is required", 400);
  const from = config.from || config.user;

  const session = createSmtpSession(await connectSocket(config));
  try {
    let response = await session.read();
    if (Number(response.slice(0, 3)) !== 220) throw new Error(response);
    await session.command("EHLO localhost", [250]);

    if (!config.secure) {
      await session.command("STARTTLS", [220]);
      const secureSocket = tls.connect({ socket: session.stream, servername: config.host });
      await new Promise((resolve, reject) => {
        secureSocket.once("secureConnect", resolve);
        secureSocket.once("error", reject);
      });
      session.setStream(secureSocket);
      await session.command("EHLO localhost", [250]);
    }

    await session.command("AUTH LOGIN", [334]);
    await session.command(Buffer.from(config.user).toString("base64"), [334]);
    await session.command(Buffer.from(config.password).toString("base64"), [235]);
    await session.command(`MAIL FROM:<${from}>`, [250]);
    await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await session.command("DATA", [354]);
    const message = [
      `From: ${encodeHeader(from)}`,
      `To: ${encodeHeader(recipient)}`,
      `Subject: ${encodeHeader(subject || "MyFund SMTP test")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      dotStuff(text || "MyFund SMTP test email."),
    ].join("\r\n");
    await session.command(`${message}\r\n.`, [250]);
    await session.command("QUIT", [221]);
    return { ok: true };
  } finally {
    session.end();
  }
}

// --- Finnomena NAV fetcher ---
async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "application/json,text/html;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function getFinnomenaFundList() {
  const list = await fetchJson("https://www.finnomena.com/fn3/api/fund/public/list");
  return Array.isArray(list) ? list : (list.value ?? []);
}

function inferCompany(fund) {
  const code = String(fund.short_code ?? fund.code ?? "").toUpperCase();
  const name = String(fund.name_th ?? fund.nameTh ?? "");
  const rules = [
    [/^(SCB|SCBLEQ|SCB[A-Z0-9-]*)/, "SCBAM"],
    [/^(KT|KTMUNG|KTEF|KTF|KT[A-Z0-9-]*)/, "KTAM"],
    [/^(K-|K[A-Z0-9]+-)/, "KAsset"],
    [/^(ES-|TMB|TMB[A-Z0-9-]*)/, "Eastspring"],
    [/^(B-|B[A-Z0-9]+-)/, "BBLAM"],
    [/^(AB|AB[A-Z0-9-]*)/, "abrdn"],
    [/^(UOB|UOB[A-Z0-9-]*)/, "UOBAM"],
    [/^(TISCO|TISCO[A-Z0-9-]*)/, "TISCOAM"],
    [/^(ONE|ONE[A-Z0-9-]*)/, "ONEAM"],
    [/^(MFC|MFC[A-Z0-9-]*)/, "MFC"],
    [/^(LH|LH[A-Z0-9-]*)/, "LHFUND"],
    [/^(PRINCIPAL|PRINCIPAL[A-Z0-9-]*)/, "Principal"],
    [/^(KKP|KKP[A-Z0-9-]*)/, "KKPAM"],
    [/^(DAOL|DAOL[A-Z0-9-]*)/, "DAOL"],
    [/^(X|XSPRING|X[A-Z0-9-]*)/, "XSpring"],
    [/^(ASP|ASP[A-Z0-9-]*)/, "ASP"],
    [/^(BCAP|BCAP[A-Z0-9-]*)/, "BCAP"],
    [/^(AIA|AIA[A-Z0-9-]*)/, "AIAIMT"],
    [/^(KWI|KWI[A-Z0-9-]*)/, "KWI"],
  ];
  for (const [pattern, company] of rules) {
    if (pattern.test(code)) return company;
  }
  if (name.includes("ไทยพาณิชย์")) return "SCBAM";
  if (name.includes("กรุงไทย")) return "KTAM";
  if (name.includes("กสิกร")) return "KAsset";
  if (name.includes("บัวหลวง")) return "BBLAM";
  return "อื่นๆ";
}

function classifyFundType(fund) {
  const code = String(fund.short_code ?? fund.code ?? "").toUpperCase();
  const taxType = String(fund.fund_tax_type ?? "").toUpperCase();
  if (code.includes("THAIESG") || taxType.includes("THAIESG")) return "ThaiESG";
  if (code.includes("RMF") || taxType.includes("RMF")) return "RMF";
  if (code.includes("SSF") || taxType.includes("SSF")) return "SSF";
  if (code.includes("LTF") || taxType.includes("LTF")) return "LTF";
  return fund.aimc_broad_category_name_en ?? fund.aimc_broad_category ?? "Fund";
}

function defaultHoldYears(type) {
  if (type === "ThaiESG") return 5;
  if (type === "SSF") return 10;
  if (type === "RMF") return 0;
  if (type === "LTF") return 7;
  return 0;
}

function normalizeCatalogFund(fund) {
  const code = fund.short_code ?? "";
  const company = fund.amc_name_en ?? inferCompany(fund);
  return {
    id: fund.id,
    code,
    nameTh: fund.name_th ?? "",
    company,
    category: fund.aimc_category ?? fund.aimc_category_name_en ?? "",
    type: classifyFundType(fund),
    searchText: `${company} ${code} ${fund.name_th ?? ""}`.toLowerCase(),
  };
}

async function getFundCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogCache.createdAt < catalogTtlMs) return catalogCache.data;

  const list = await getFinnomenaFundList();
  const funds = list.map(normalizeCatalogFund).filter((fund) => fund.id && fund.code);
  const companyMap = new Map();
  for (const fund of funds) {
    const current = companyMap.get(fund.company) ?? { name: fund.company, count: 0 };
    current.count += 1;
    companyMap.set(fund.company, current);
  }
  const companies = [...companyMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const data = { updatedAt: new Date().toISOString(), companies, funds };
  catalogCache = { createdAt: now, data };
  return data;
}

async function getFundDetailFromFinnomena({ id, code }) {
  let fundId = id;
  if (!fundId && code) {
    const catalog = await getFundCatalog();
    fundId = catalog.funds.find((fund) => fund.code === code)?.id;
  }
  if (!fundId) throw new Error("Fund id or code is required");

  const detail = await fetchJson(`https://www.finnomena.com/fn3/api/fund/public/${encodeURIComponent(fundId)}`);
  const catalogFund = normalizeCatalogFund(detail);
  const nav = await getNavFromFinnomena(catalogFund.code, [detail]);
  const type = classifyFundType(detail);
  return {
    id: fundId,
    code: catalogFund.code,
    nameTh: detail.name_th ?? catalogFund.nameTh,
    nameEn: detail.name_en ?? "",
    company: detail.amc_name_en ?? catalogFund.company,
    category: detail.aimc_category ?? "",
    type,
    holdYears: defaultHoldYears(type),
    nav: nav.nav,
    navDate: nav.navDate,
    navDateDisplay: formatDate(nav.navDate),
    sourceUrl: `https://www.finnomena.com/fund/${encodeURIComponent(catalogFund.code)}`,
  };
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
  const pathname = decodeURIComponent(url.pathname);
  const isAdminRoute = pathname === "/admin" || pathname === "/admin/";
  const isProfileRoute = /^\/[^/.]+\/?$/.test(pathname) && pathname !== "/api";
  const requestPath = pathname === "/"
    ? "/index.html"
    : isAdminRoute
      ? "/admin.html"
    : isProfileRoute
      ? "/profile.html"
      : pathname;
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
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/(data|refresh-nav|holdings|funds)$/);
  const profileRootMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  const adminProfileMatch = url.pathname.match(/^\/api\/admin\/profiles\/([^/]+)$/);
  const profileSlug = profileMatch ? slugifyProfile(decodeURIComponent(profileMatch[1])) : defaultProfileSlug;
  const profileAction = profileMatch?.[2] ?? null;

  try {
    // POST /api/admin/verify — verify admin password for admin page access
    if (request.method === "POST" && url.pathname === "/api/admin/verify") {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 200, { ok: true });
      return;
    }

    // PATCH /api/admin/password — change admin password
    if (request.method === "PATCH" && url.pathname === "/api/admin/password") {
      sendJson(response, 200, await changeAdminPassword(await readJsonBody(request)));
      return;
    }

    // GET /api/admin/smtp — read public SMTP settings
    if (request.method === "GET" && url.pathname === "/api/admin/smtp") {
      sendJson(response, 200, publicSmtpConfig(await readSmtpConfig()));
      return;
    }

    // PUT /api/admin/smtp — save SMTP settings
    if (request.method === "PUT" && url.pathname === "/api/admin/smtp") {
      sendJson(response, 200, await saveSmtpConfig(await readJsonBody(request)));
      return;
    }

    // POST /api/admin/smtp/test — send test email
    if (request.method === "POST" && url.pathname === "/api/admin/smtp/test") {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 200, await sendSmtpMail({
        to: body.to,
        subject: body.subject,
        text: body.text,
      }));
      return;
    }

    // POST /api/admin/profiles — admin-only create profile
    if (request.method === "POST" && url.pathname === "/api/admin/profiles") {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 201, await createProfile(body));
      return;
    }

    // PATCH /api/admin/profiles/:slug — admin-only rename profile
    if (request.method === "PATCH" && adminProfileMatch) {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 200, await renameProfile(decodeURIComponent(adminProfileMatch[1]), body));
      return;
    }

    // DELETE /api/admin/profiles/:slug — admin-only delete profile
    if (request.method === "DELETE" && adminProfileMatch) {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 200, await deleteProfile(decodeURIComponent(adminProfileMatch[1])));
      return;
    }

    // GET /api/profiles — list available isolated portfolios
    if (request.method === "GET" && url.pathname === "/api/profiles") {
      sendJson(response, 200, { profiles: await listProfiles() });
      return;
    }

    // POST /api/profiles — create an empty independent portfolio
    if (request.method === "POST" && url.pathname === "/api/profiles") {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 201, await createProfile(body));
      return;
    }

    // PATCH /api/profiles/:slug — rename profile and move its backing data file
    if (request.method === "PATCH" && profileRootMatch) {
      const body = await readJsonBody(request);
      await requireAdmin(body.password);
      sendJson(response, 200, await renameProfile(decodeURIComponent(profileRootMatch[1]), body));
      return;
    }

    // GET /api/data — read + recalculate
    if (request.method === "GET" && (url.pathname === "/api/data" || profileAction === "data")) {
      sendJson(response, 200, calculateData(await readData(profileSlug)));
      return;
    }

    // GET /api/fund-catalog — searchable Finnomena fund catalog
    if (request.method === "GET" && url.pathname === "/api/fund-catalog") {
      sendJson(response, 200, await getFundCatalog());
      return;
    }

    // GET /api/fund-detail?id=... — selected fund details with latest NAV
    if (request.method === "GET" && url.pathname === "/api/fund-detail") {
      sendJson(response, 200, await getFundDetailFromFinnomena({
        id: url.searchParams.get("id"),
        code: url.searchParams.get("code"),
      }));
      return;
    }

    // POST /api/refresh-nav — fetch latest NAV from Finnomena, save, return updated data
    if (request.method === "POST" && (url.pathname === "/api/refresh-nav" || profileAction === "refresh-nav")) {
      const current = await readData(profileSlug);
      const { updatedFunds, errors } = await refreshNavFromFinnomena(current);
      const updatedAt = new Date().toISOString();
      const next = calculateData({
        ...current,
        updatedAt,
        source: "https://www.finnomena.com/",
        funds: updatedFunds,
      });
      delete next.rows;
      await writeData(next, profileSlug);
      sendJson(response, 200, { ...next, navRefreshErrors: errors });
      return;
    }

    // PUT /api/holdings — replace holdings array
    if (request.method === "PUT" && (url.pathname === "/api/holdings" || profileAction === "holdings")) {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.holdings)) {
        sendJson(response, 400, { error: "holdings must be an array" });
        return;
      }
      const current = await readData(profileSlug);
      const next = calculateData({
        ...current,
        updatedAt: new Date().toISOString(),
        holdings: body.holdings,
      });
      delete next.rows;
      await writeData(next, profileSlug);
      sendJson(response, 200, next);
      return;
    }

    // PUT /api/funds — replace funds array
    if (request.method === "PUT" && (url.pathname === "/api/funds" || profileAction === "funds")) {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.funds)) {
        sendJson(response, 400, { error: "funds must be an array" });
        return;
      }
      const current = await readData(profileSlug);
      const next = calculateData({
        ...current,
        updatedAt: new Date().toISOString(),
        funds: body.funds,
      });
      delete next.rows;
      await writeData(next, profileSlug);
      sendJson(response, 200, next);
      return;
    }

    await serveStatic(request, response, url);
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error.message });
  }
});

await ensureProfileStore();
await ensureAdminStore();
await ensureSmtpStore();

server.listen(port, "127.0.0.1", () => {
  console.log(`MyFund web app: http://127.0.0.1:${port}/`);
});
