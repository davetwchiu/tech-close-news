const state = {
  loading: false
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  marketDate: document.querySelector("#marketDate"),
  lastPull: document.querySelector("#lastPull"),
  nextClose: document.querySelector("#nextClose"),
  sourceLabel: document.querySelector("#sourceLabel"),
  companyCount: document.querySelector("#companyCount"),
  rankList: document.querySelector("#rankList"),
  emptyState: document.querySelector("#emptyState"),
  companyGrid: document.querySelector("#companyGrid")
};

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

function formatPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPrice(value) {
  return value === null ? "n/a" : moneyFormatter.format(value);
}

function formatMarketCap(value) {
  return value === null ? "n/a" : `$${compactFormatter.format(value)}`;
}

function formatTime(value) {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.querySelector("span").textContent = isLoading ? "..." : "R";
}

function renderMiniBars(percentChange) {
  const capped = Math.max(8, Math.min(percentChange, 80));
  return Array.from({ length: 10 }, (_, index) => {
    const height = Math.max(8, (capped / 80) * 20 + (index + 1) * 4);
    return `<span style="height:${height}px"></span>`;
  }).join("");
}

function renderRank(companies) {
  elements.companyCount.textContent = companies.length;
  elements.rankList.innerHTML = companies
    .map(
      (company, index) => `
        <li class="rank-item">
          <span class="rank-num">${String(index + 1).padStart(2, "0")}</span>
          <span>
            <span class="rank-symbol">${company.symbol}</span>
            <span class="rank-name">${escapeHtml(company.name)}</span>
          </span>
          <span class="gain-pill">${formatPercent(company.percentChange)}</span>
        </li>
      `
    )
    .join("");
}

function renderNews(company) {
  if (!company.news?.length) {
    return `<li class="news-item"><div class="thumb-fallback">${company.symbol[0]}</div><div class="news-link"><h3>No recent news found</h3><p>Yahoo Finance search</p></div></li>`;
  }

  return company.news
    .map((item) => {
      if (item.error) {
        return `<li class="news-item"><div class="thumb-fallback">!</div><div class="news-link"><h3>News unavailable</h3><p>${escapeHtml(item.error)}</p></div></li>`;
      }
      const media = item.thumbnail
        ? `<img class="thumb" src="${safeUrl(item.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="thumb-fallback">${company.symbol[0]}</div>`;
      return `
        <li class="news-item">
          ${media}
          <a class="news-link" href="${safeUrl(item.link)}" target="_blank" rel="noreferrer">
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.publisher || "News")} · ${escapeHtml(item.publishedLabel || formatTime(item.publishedAt))}</p>
          </a>
        </li>
      `;
    })
    .join("");
}

function renderCompanies(companies) {
  elements.emptyState.classList.toggle("hidden", companies.length > 0);
  elements.companyGrid.innerHTML = companies
    .map(
      (company) => `
        <article class="company-card">
          <header class="company-head">
            <div class="identity">
              <div>
                <div class="ticker">${company.symbol}</div>
                <p class="company-name">${escapeHtml(company.name)}</p>
              </div>
              <div class="gain">${formatPercent(company.percentChange)}</div>
            </div>
            <div class="mini-bars" aria-hidden="true">${renderMiniBars(company.percentChange)}</div>
            <div class="meta">
              <div><span>Price</span><strong>${formatPrice(company.price)}</strong></div>
              <div><span>Market cap</span><strong>${formatMarketCap(company.marketCap)}</strong></div>
              <div><span>Industry</span><strong title="${escapeHtml(company.industry || "")}">${escapeHtml(company.industry || "Technology")}</strong></div>
            </div>
          </header>
          <ul class="news-list">
            ${renderNews(company)}
          </ul>
        </article>
      `
    )
    .join("");
}

function renderSnapshot(snapshot) {
  const companies = snapshot.companies || [];
  elements.marketDate.textContent = snapshot.marketDate || "n/a";
  elements.lastPull.textContent = formatTime(snapshot.refreshedAt);
  elements.nextClose.textContent = snapshot.nextRegularClose || "n/a";
  elements.sourceLabel.textContent = `${snapshot.sources?.movers || "Market"} + ${snapshot.sources?.news || "News"}`;
  renderRank(companies);
  renderCompanies(companies);
}

async function loadSnapshot(force = false) {
  setLoading(true);
  try {
    const response = await fetch(`/api/close-gainers${force ? "?refresh=1" : ""}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "Request failed");
    renderSnapshot(payload);
  } catch (error) {
    elements.emptyState.classList.remove("hidden");
    elements.emptyState.textContent = `Could not load market data: ${error.message}`;
  } finally {
    setLoading(false);
  }
}

elements.refreshButton.addEventListener("click", () => loadSnapshot(true));

loadSnapshot();
