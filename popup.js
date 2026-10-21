import { slim, pageQuery, findMatches, classify, timeline, normName, parseTs, STATUS_LABEL, APPLIED, REJECTED, SAVED } from './lib.js';

const API = 'https://api.simplify.jobs/v2/candidate/me/tracker/';
const PAGE_SIZE = 500;
const LEVEL_TEXT = { green: '🟢 可以投', yellow: '🟡 谨慎投', red: '🔴 基本不用投' };
const BADGE_COLOR = { green: '#2da44e', yellow: '#d4a72c', red: '#cf222e' };

const $ = id => document.getElementById(id);
let records = null;
let tabId = null;
let pageInfo = null;

class AuthError extends Error {}

// Runs inside the job posting tab, so it must be self-contained.
function scrapePage() {
  const out = { url: location.href, names: [], frameUrls: [] };
  const visit = d => {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d)) return d.forEach(visit);
    if (d['@graph']) visit(d['@graph']);
    if ([].concat(d['@type']).includes('JobPosting')) {
      const org = d.hiringOrganization;
      const name = typeof org === 'string' ? org : org?.name;
      if (name) out.names.push(name);
    }
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    // Some boards (HigherEdJobs) ship trailing commas; retry without them.
    try { visit(JSON.parse(s.textContent)); } catch {
      try { visit(JSON.parse(s.textContent.replace(/,(\s*[}\]])/g, '$1'))); } catch {}
    }
  }
  // The posting's own employer beats anything about the site hosting it.
  out.fromPosting = out.names.length > 0;
  const visible = e => e.getClientRects().length > 0;
  const text = e => (e?.getAttribute('aria-label')?.replace(/^Company,\s*/, '') || e?.textContent || '').trim();
  const board = /linkedin\.com|indeed\.com|joinhandshake\.com/.test(location.hostname);

  // Job boards (LinkedIn, Indeed, Handshake) keep the company out of the URL,
  // and in list views several postings are on screen. Known selectors first,
  // then the company-page link nearest the job title of the open posting.
  const KNOWN = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    '[aria-label^="Company, "]',
    '[data-testid="company-info-metadata"] a[href*="/cmp/"]',
    '[data-testid="inlineHeader-companyName"]',
    '[data-testid="jobsearch-CompanyInfoContainer"] a[href*="/cmp/"]',
    '[data-company-name]',
  ];
  const COMPANY_LINK = 'a[href*="/company/"], a[href*="/cmp/"], a[href*="/employers/"], a[href*="joinhandshake.com/e/"], a[href^="/e/"]';
  let found = null;
  if (board) {
    for (const sel of KNOWN) {
      found = [...document.querySelectorAll(sel)].find(e => visible(e) && text(e));
      if (found) break;
    }
    if (!found) {
      outer: for (const h of document.querySelectorAll('h1, h2')) {
        if (!visible(h)) continue;
        for (let n = h.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
          found = [...n.querySelectorAll(COMPANY_LINK)].find(a => visible(a) && text(a));
          if (found) break outer;
        }
      }
    }
  }
  if (found) out.names.push(text(found).split('\n')[0].trim());

  const guess = !board && !out.fromPosting;
  const site = document.querySelector('meta[property="og:site_name"]')?.content;
  if (site && guess) out.names.push(site);
  // "Job Application for X at Acme" (Greenhouse), "X @ Acme" (Ashby)
  const m = document.title.match(/\s(?:at|@)\s(.+?)(?:\s[|–-]\s.*)?$/);
  if (m && guess) out.names.push(m[1]);
  // LinkedIn job page: "(3) Title | Company | LinkedIn"
  const parts = document.title.split(' | ');
  if (parts.length >= 3 && parts[parts.length - 1] === 'LinkedIn') out.names.push(parts[parts.length - 2]);
  // Signed-out LinkedIn: "Acme hiring Title in City | LinkedIn"
  const hiring = document.title.match(/^(?:\(\d+\)\s*)?(.+?) hiring .+\| LinkedIn$/);
  if (hiring) out.names.push(hiring[1]);
  // Greenhouse/Lever boards embedded on a company site live in an iframe.
  for (const f of document.querySelectorAll('iframe[src]')) out.frameUrls.push(f.src);
  return out;
}

async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapePage });
    return res?.result ?? null;
  } catch {
    return tab?.url ? { url: tab.url, names: [], frameUrls: [] } : null; // chrome:// pages etc.
  }
}

async function fetchAll() {
  const cookies = await chrome.cookies.getAll({ domain: 'simplify.jobs', name: 'csrf' });
  if (!cookies.length) throw new AuthError();
  const csrf = decodeURIComponent(cookies[0].value);
  const get = async page => {
    const res = await fetch(`${API}?page=${page}&size=${PAGE_SIZE}&value=`, {
      credentials: 'include',
      headers: { 'x-csrf-token': csrf },
    });
    if (res.status === 401 || res.status === 403) throw new AuthError();
    if (!res.ok) throw new Error(`Simplify 返回 ${res.status}`);
    return res.json();
  };
  const first = await get(0);
  const rest = await Promise.all(Array.from({ length: Math.max(0, first.pages - 1) }, (_, i) => get(i + 1)));
  return [first, ...rest].flatMap(p => p.items).map(slim);
}

const parse = parseTs;
const thisYear = new Date().getFullYear();
const fmtDate = s => {
  const d = parse(s);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === thisYear ? md : `${d.getFullYear()}/${md}`;
};
const daysSince = s => Math.floor((Date.now() - parse(s)) / 864e5);
const ago = ms => {
  const min = Math.round((Date.now() - ms) / 6e4);
  return min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
};

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(c => c != null));
  return e;
}

function renderTimeline(r) {
  const t = timeline(r);
  const box = el('div', { className: 'timeline' });
  const events = r.events.filter(e => e[0] !== SAVED);
  if (!events.length) {
    box.append(el('span', { className: 'step wait' }, `${fmtDate(r.tracked)} 收藏（未投递）`));
    return box;
  }
  events.forEach(([status, ts], i) => {
    if (i) box.append(' → ');
    const label = STATUS_LABEL[status] ?? `状态 ${status}`;
    if (status === REJECTED && t.daysToReject !== null) {
      const days = Math.max(0, Math.round(t.daysToReject));
      const fast = t.daysToReject <= 3;
      box.append(el('span', { className: 'step rej' + (fast ? ' fast' : '') },
        `${fmtDate(ts)} ${label}（${days} 天）${fast ? ' ⚡' : ''}`));
    } else {
      const cls = status === REJECTED ? 'rej' : status === APPLIED ? '' : 'prog';
      box.append(el('span', { className: `step ${cls}` }, `${fmtDate(ts)} ${label}`));
    }
  });
  const [lastStatus, lastTs] = events[events.length - 1];
  if (lastStatus !== REJECTED) {
    const what = lastStatus === APPLIED ? '无回复' : `停在 ${STATUS_LABEL[lastStatus] ?? lastStatus}`;
    box.append(el('span', { className: t.ghosted ? 'step ghost' : 'step wait' },
      ` · ${daysSince(lastTs)} 天${what}${t.ghosted ? ' 👻' : ''}`));
  }
  return box;
}

function renderRecord(r, showCompany) {
  const link = el('a', {
    className: 'title',
    href: `https://simplify.jobs/tracker?id=${r.id}`,
    target: '_blank',
    title: '在 Simplify 打开这条记录',
  }, r.title);
  const meta = el('div', { className: 'meta' },
    [r.location, showCompany ? r.company : null].filter(Boolean).join(' · '));
  if (r.url) meta.append(r.location || showCompany ? ' · ' : '', el('a', { href: r.url, target: '_blank' }, '原 posting ↗'));
  return el('li', {}, link, meta, renderTimeline(r));
}

function render() {
  const query = $('search').value.trim();
  // A typed query also matches as a substring ("north" finds "Northwind Bank").
  const q = query ? { keys: new Set(), names: new Set([normName(query)]), partial: true } : pageInfo ? pageQuery(pageInfo) : null;
  $('records').replaceChildren();
  $('maybe').hidden = true;
  $('verdict').replaceChildren();
  $('verdict').className = '';

  if (!records) return;
  const companyKeys = q ? [...q.keys].filter(k => !k.startsWith('post:')) : [];
  const { exact, maybe } = q ? findMatches(records, q) : { exact: [], maybe: [] };
  // A posting id alone can confirm "applied to this exact posting" but can't
  // vouch for the company, so without a name a miss says nothing.
  if (!q || (!q.names.size && !companyKeys.length && !exact.length)) {
    $('detected').textContent = '没识别出这个页面的公司，请在上面手动搜索。';
    return;
  }
  $('detected').textContent = query ? `搜索：${query}` : `识别为：${[...companyKeys, ...q.names].join(' / ') || '同一个岗位 ID'}`;
  const { level, reasons } = classify(exact);
  // No exact hit but similar names: don't claim "never applied".
  const unsure = !exact.length && maybe.length;
  $('verdict').className = unsure ? 'unsure' : level;
  if (unsure) $('verdict').append('⚪ 没有完全匹配，但有名字相近的公司，请看下面确认');
  else $('verdict').append(LEVEL_TEXT[level], ...reasons.map(x => el('span', { className: 'reason' }, x)));

  const companies = new Set(exact.map(r => r.company));
  $('records').append(...exact.map(r => renderRecord(r, companies.size > 1)));

  if (maybe.length) {
    $('maybe').hidden = false;
    $('maybe').open = unsure;
    $('maybe').querySelector('summary').textContent =
      `可能相关（名字相近，不计入颜色）：${[...new Set(maybe.map(r => r.company))].join('、')}`;
    $('maybe-records').replaceChildren(...maybe.map(r => renderRecord(r, true)));
  }

  if (!query && tabId !== null) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: unsure ? '#8c959f' : BADGE_COLOR[level] });
    chrome.action.setBadgeText({ tabId, text: exact.length ? String(exact.length) : ' ' });
  }
}

async function refresh() {
  $('sync').textContent = '正在从 Simplify 拉取…';
  $('sync').classList.remove('error');
  try {
    records = await fetchAll();
    const fetchedAt = Date.now();
    await chrome.storage.local.set({ cache: { fetchedAt, records } });
    $('sync').textContent = `${records.length} 条记录 · 更新于 ${ago(fetchedAt)}`;
    render();
  } catch (e) {
    $('sync').classList.add('error');
    $('sync').textContent = e instanceof AuthError
      ? '未登录 Simplify：请先在 Chrome 打开 simplify.jobs 登录'
      : `拉取失败：${e.message}（显示的是缓存）`;
  }
}

async function main() {
  const [{ cache }, page] = await Promise.all([chrome.storage.local.get('cache'), scrapeActiveTab()]);
  pageInfo = page;
  if (cache) {
    records = cache.records;
    $('sync').textContent = `${records.length} 条记录 · 缓存于 ${ago(cache.fetchedAt)}`;
    render();
  }
  refresh();
}

let timer;
$('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
$('refresh').addEventListener('click', refresh);
main();
