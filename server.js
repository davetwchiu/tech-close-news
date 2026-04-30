import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const NASDAQ_SCREENER_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=12000&offset=0&download=true";
const NASDAQ_NEWS_URL = "https://api.nasdaq.com/api/news/topic/articlebysymbol";
const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const TECH_SECTOR = "Technology";
const NEWS_PER_COMPANY = 3;

const sourceHeaders = {
  "Accept": "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Origin": "https://www.nasdaq.com",
  "Referer": "https://www.nasdaq.com/"
};

let closeSnapshot = null;
let refreshInFlight = null;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(String(value).replace(/[$,%+,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMarketCap(value) {
  const numeric = parseNumber(value);
  return numeric === null ? null : numeric;
}

function cleanSymbol(symbol) {
  return String(symbol || "").replace(/\^/g, "-").trim().toUpperCase();
}

function marketDateInNewYork(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

function newYorkParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function isRegularCloseWindow(date = new Date()) {
  const { weekday, hour, minute } = newYorkParts(date);
  const weekdayOpen = !["Sat", "Sun"].includes(weekday);
  return weekdayOpen && (hour > 16 || (hour === 16 && minute >= 0));
}

function nextRegularCloseLabel(date = new Date()) {
  const next = new Date(date);
  const ny = newYorkParts(next);
  const afterClose = ny.hour > 16 || (ny.hour === 16 && ny.minute >= 0);
  if (["Sat", "Sun"].includes(ny.weekday) || afterClose) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  while (["Sat", "Sun"].includes(newYorkParts(next).weekday)) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return `${marketDateInNewYork(next)} 4:00 PM ET`;
}

async function fetchNasdaqRows() {
  const response = await fetch(NASDAQ_SCREENER_URL, { headers: sourceHeaders });
  if (!response.ok) {
    throw new Error(`Nasdaq screener returned ${response.status}`);
  }
  const payload = await response.json();
  return payload?.data?.rows || [];
}

function normalizeNasdaqImage(item) {
  if (!item.image) return null;
  if (item.image.startsWith("http")) return item.image;
  if (item.imagedomain) return `${item.imagedomain}${item.image}`;
  return `https://www.nasdaq.com${item.image}`;
}

async function fetchNasdaqNews(company) {
  const url = new URL(NASDAQ_NEWS_URL);
  url.searchParams.set("q", `${company.symbol}|stocks`);
  url.searchParams.set("offset", "0");
  url.searchParams.set("limit", String(NEWS_PER_COMPANY));

  const response = await fetch(url, { headers: sourceHeaders });
  if (!response.ok) throw new Error(`Nasdaq news returned ${response.status}`);
  const payload = await response.json();
  return (payload?.data?.rows || []).slice(0, NEWS_PER_COMPANY).map((item) => ({
    id: String(item.id || item.url || item.title),
    title: item.title,
    publisher: item.publisher,
    link: item.url?.startsWith("http") ? item.url : `https://www.nasdaq.com${item.url}`,
    publishedAt: null,
    publishedLabel: item.ago || item.created || null,
    thumbnail: normalizeNasdaqImage(item)
  }));
}

async function fetchYahooNews(company) {
  const query = `${company.symbol} ${company.name}`;
  const url = new URL(YAHOO_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("newsCount", String(NEWS_PER_COMPANY));

  try {
    let response = await fetch(url, { headers: sourceHeaders });
    if (response.status === 429) {
      await delay(1200);
      response = await fetch(url, { headers: sourceHeaders });
    }
    if (!response.ok) throw new Error(`Yahoo news returned ${response.status}`);
    const payload = await response.json();
    return (payload.news || []).slice(0, NEWS_PER_COMPANY).map((item) => ({
      id: item.uuid,
      title: item.title,
      publisher: item.publisher,
      link: item.link,
      publishedAt: item.providerPublishTime
        ? new Date(item.providerPublishTime * 1000).toISOString()
        : null,
      publishedLabel: null,
      thumbnail:
        item.thumbnail?.resolutions?.find((image) => image.width >= 300)?.url ||
        item.thumbnail?.resolutions?.[0]?.url ||
        null
    }));
  } catch (error) {
    return [{ error: error.message }];
  }
}

async function fetchCompanyNews(company) {
  try {
    const nasdaqNews = await fetchNasdaqNews(company);
    if (nasdaqNews.length) return nasdaqNews;
  } catch {
    // Fall back to Yahoo below.
  }
  return fetchYahooNews(company);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildSnapshot(trigger = "manual") {
  const rows = await fetchNasdaqRows();
  const gainers = rows
    .map((row) => ({
      symbol: cleanSymbol(row.symbol),
      name: String(row.name || "").replace(/\s+/g, " ").trim(),
      price: parseNumber(row.lastsale),
      netChange: parseNumber(row.netchange),
      percentChange: parseNumber(row.pctchange),
      marketCap: parseMarketCap(row.marketCap),
      country: row.country || null,
      sector: row.sector || null,
      industry: row.industry || null,
      sourceUrl: row.url ? `https://www.nasdaq.com${row.url}` : null
    }))
    .filter(
      (row) =>
        row.symbol &&
        row.sector === TECH_SECTOR &&
        row.percentChange !== null &&
        row.percentChange > 0
    )
    .sort((a, b) => b.percentChange - a.percentChange)
    .slice(0, 10);

  const companies = [];
  for (const company of gainers) {
    companies.push({
      ...company,
      news: await fetchCompanyNews(company)
    });
    await delay(250);
  }

  closeSnapshot = {
    trigger,
    marketDate: marketDateInNewYork(),
    refreshedAt: new Date().toISOString(),
    nextRegularClose: nextRegularCloseLabel(),
    sources: {
      movers: "Nasdaq screener",
      news: "Nasdaq symbol news"
    },
    companies
  };

  return closeSnapshot;
}

async function getSnapshot({ force = false, trigger = "manual" } = {}) {
  if (refreshInFlight) return refreshInFlight;
  const stale =
    !closeSnapshot ||
    Date.now() - new Date(closeSnapshot.refreshedAt).getTime() > 15 * 60 * 1000;

  if (!force && closeSnapshot && !stale) return closeSnapshot;

  refreshInFlight = buildSnapshot(trigger).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function scheduleCloseRefresh() {
  setInterval(() => {
    const today = marketDateInNewYork();
    const alreadyPulled = closeSnapshot?.marketDate === today;
    if (isRegularCloseWindow() && !alreadyPulled) {
      getSnapshot({ force: true, trigger: "scheduled-close" }).catch((error) => {
        console.error(`[scheduler] ${error.stack || error.message}`);
      });
    }
  }, 60 * 1000);
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8"
      }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/close-gainers") {
    try {
      const snapshot = await getSnapshot({
        force: url.searchParams.get("refresh") === "1",
        trigger: url.searchParams.get("refresh") === "1" ? "manual-refresh" : "api"
      });
      sendJson(res, 200, snapshot);
    } catch (error) {
      sendJson(res, 502, {
        error: "Unable to load market data",
        detail: error.message,
        cached: closeSnapshot
      });
    }
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, cached: Boolean(closeSnapshot) });
    return;
  }

  await serveStatic(req, res);
});

scheduleCloseRefresh();

if (isRegularCloseWindow()) {
  getSnapshot({ force: true, trigger: "startup-after-close" }).catch((error) => {
    console.error(`[startup] ${error.stack || error.message}`);
  });
}

server.listen(port, () => {
  console.log(`Tech close news dashboard running at http://localhost:${port}`);
});
