// Pure logic (no chrome.* calls) so it can be tested outside the extension.

export const SAVED = 1, APPLIED = 2, REJECTED = 23;
export const STATUS_LABEL = { 1: '收藏', 2: '投递', 11: 'Screen', 12: '面试', 23: '被拒' };

const DAY = 864e5;

// Company names in Simplify are inconsistent ("NorthwindBank" / "Northwind Bank",
// "GLOBEX INC" / "globex"), so compare a normalized form.
const SUFFIXES = /\b(inc|llc|corp|corporation|co|ltd|limited|the|group|holdings|technologies|technology|company|plc)\b/g;

export function normName(s) {
  if (!s) return '';
  const base = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  // "Smith & Co." leaves a dangling "and" once "co" is stripped.
  const core = base.replace(SUFFIXES, ' ').replace(/\band\s*$/, '');
  return core.replace(/\s+/g, '') || base.replace(/\s+/g, '');
}

// Job boards and ATS hosts whose domain says nothing about the employer.
const NEUTRAL_HOSTS = /(^|\.)(linkedin|indeed|glassdoor|simplify|builtin|wellfound|ziprecruiter|dice|handshake|joinhandshake|google|careerpuck|higheredjobs|chroniclevitae|insidehighered|monster|careerbuilder|usajobs|idealist|otta|welcometothejungle|jobright|oraclecloud|ultipro|taleo|successfactors|adp|paylocity|bamboohr|jobvite|teamtailor|rippling|dover|pinpointhq|workable|breezy|applytojob|recruitee|icims|myworkday\w*|greenhouse|lever|ashbyhq|smartrecruiters)\./;

// ATS identity from a posting URL, e.g. "greenhouse:acme". These survive
// reposts and company renames, so they are the strongest match signal.
export function atsKeys(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const h = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const sub = h.split('.')[0];
  const keys = [];
  const add = (ats, slug) => { if (slug) keys.push(`${ats}:${decodeURIComponent(slug).toLowerCase()}`); };

  if (/(^|\.)greenhouse\.io$/.test(h)) add('greenhouse', seg[0] === 'embed' ? u.searchParams.get('for') : seg[0]);
  else if (h === 'jobs.ashbyhq.com') add('ashby', seg[0]);
  else if (/^jobs(\.eu)?\.lever\.co$/.test(h)) add('lever', seg[0]);
  else if (h.endsWith('smartrecruiters.com')) add('smartrecruiters', seg[0]);
  else if (h.endsWith('.myworkdayjobs.com')) add('workday', sub);
  else if (h.endsWith('myworkdaysite.com') && seg[0] === 'recruiting') add('workday', seg[1]);
  else if (h.endsWith('.icims.com')) add('icims', sub);
  else if (h.endsWith('workable.com')) add('workable', h === 'apply.workable.com' ? seg[0] : sub);
  else if (h.endsWith('.breezy.hr')) add('breezy', sub);
  else if (h.endsWith('.applytojob.com')) add('jazzhr', sub);
  else if (h.endsWith('.recruitee.com')) add('recruitee', sub);
  return keys;
}

// Job boards identify one posting, not a company: "post:linkedin:1234567890".
// It only catches the very same posting, so it never feeds name matching.
export function postingKeys(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const h = u.hostname.toLowerCase();
  const p = u.pathname;
  const id = h.endsWith('linkedin.com') ? (p.match(/\/jobs\/view\/(\d+)/)?.[1] || u.searchParams.get('currentJobId'))
    : h.endsWith('indeed.com') ? (u.searchParams.get('vjk') || u.searchParams.get('jk'))
    : h.endsWith('joinhandshake.com') ? p.match(/\/(?:jobs|job-search)\/(\d+)/)?.[1]
    : null;
  return id ? [`post:${h.split('.').slice(-2, -1)[0]}:${id}`] : [];
}

// Company-hosted careers pages (careers.acme.com) only give a domain label.
export function domainName(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (NEUTRAL_HOSTS.test(h) || atsKeys(url).length) return null;
  const parts = h.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

const TRACKED_ATS = { greenhouse: 'greenhouse', ashbyhq: 'ashby', lever: 'lever', smartrecruiters: 'smartrecruiters', icims: 'icims' };

// tracked_obj looks like "greenhouse:acme/jobs/123"; workday's holds the
// site name rather than the tenant, so it is skipped in favor of the URL.
function trackedKeys(obj) {
  if (!obj) return [];
  if (/^https?:/.test(obj)) return [...atsKeys(obj), ...postingKeys(obj)];
  const [src, rest = ''] = obj.split(/:(.*)/);
  if (src === 'linkedin' || src === 'indeed') return [`post:${src}:${rest}`];
  const ats = TRACKED_ATS[src];
  const slug = rest.split('/')[0];
  return ats && slug ? [`${ats}:${slug.toLowerCase()}`] : [];
}

// Keep only what the popup needs; the raw records carry the whole JD.
export function slim(item) {
  const keys = new Set([...trackedKeys(item.tracked_obj), ...atsKeys(item.job_posting_url), ...postingKeys(item.job_posting_url)]);
  const dn = domainName(item.job_posting_url);
  return {
    id: item.id,
    company: item.company?.name || 'Unknown',
    companyId: item.company_id,
    title: item.job_posting_title || '(无岗位名)',
    url: item.job_posting_url,
    location: item.job_posting_location,
    tracked: item.tracked_date,
    events: (item.status_events || [])
      .map(e => [e.status, e.timestamp])
      .sort((a, b) => a[1].localeCompare(b[1])),
    keys: [...keys],
    norm: normName(item.company?.name),
    domain: dn ? normName(dn) : null,
  };
}

// What to look for, from the scraped page (or a typed query).
export function pageQuery(page) {
  const keys = new Set();
  for (const u of [page.url, ...(page.frameUrls || [])]) atsKeys(u).forEach(k => keys.add(k));
  const names = new Set();
  for (const n of page.names || []) names.add(normName(n));
  // ATS slugs are usually the company name too ("acme", "acme-2").
  for (const k of keys) names.add(normName(k.split(':')[1].replace(/-\d+$/, '').replace(/[-_]/g, ' ')));
  postingKeys(page.url).forEach(k => keys.add(k));
  // Indeed company pages: indeed.com/cmp/Acme-Widgets,-Llc./jobs
  const cmp = page.url.match(/indeed\.com\/cmp\/([^/?#]+)/)?.[1];
  if (cmp) names.add(normName(decodeURIComponent(cmp).replace(/-/g, ' ')));
  // On a job board the domain is the board, so only use it as a last resort.
  const dn = page.fromPosting ? null : domainName(page.url);
  if (dn) names.add(normName(dn));
  names.delete('');
  return { keys, names };
}

function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

function similar(a, b) {
  const len = Math.min(a.length, b.length);
  // A prefix always counts ("acme" / "acmerobotics"); containment elsewhere
  // only when it is a real part of the longer name (not "compa" in "notacompany").
  if (len >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (len >= 4 && len / Math.max(a.length, b.length) >= 0.5 && (a.includes(b) || b.includes(a))) return true;
  if (len < 5) return false;
  return lev(a, b) <= (len >= 8 ? 2 : 1);
}

// exact: same ATS slug or same normalized name, widened to every record that
// shares a company id or name with a hit. maybe: fuzzy name matches, shown
// separately and never counted toward the color.
export function findMatches(records, query) {
  const { keys, names, partial } = query;
  const hit = r => r.keys.some(k => keys.has(k)) || names.has(r.norm) || (r.domain && names.has(r.domain))
    || (partial && [...names].some(n => n.length >= 3 && r.norm.includes(n)));
  const seed = records.filter(hit);
  const ids = new Set(seed.map(r => r.companyId).filter(Boolean));
  const norms = new Set(seed.map(r => r.norm));
  const exact = records.filter(r => hit(r) || ids.has(r.companyId) || norms.has(r.norm));
  const exactIds = new Set(exact.map(r => r.id));
  const maybe = records.filter(r => !exactIds.has(r.id) && [...names].some(n => similar(n, r.norm)));
  return { exact: byDateDesc(exact), maybe: byDateDesc(maybe) };
}

const byDateDesc = rs => rs.slice().sort((a, b) => (b.tracked || '').localeCompare(a.tracked || ''));

// Simplify timestamps have no zone; they are UTC.
export const parseTs = s => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');

// Most rejections arrive within about three weeks, so a month of silence
// after applying counts as being ghosted.
export const GHOST_DAYS = 30;

export function timeline(r, now = Date.now()) {
  const first = s => r.events.find(e => e[0] === s)?.[1];
  const applied = first(APPLIED);
  const rejected = first(REJECTED);
  const progressed = r.events.some(e => ![SAVED, APPLIED, REJECTED].includes(e[0]));
  const daysToReject = applied && rejected ? (parseTs(rejected) - parseTs(applied)) / DAY : null;
  const last = r.events[r.events.length - 1];
  const ghosted = !!applied && last?.[0] === APPLIED && (now - parseTs(last[1])) / DAY > GHOST_DAYS;
  return { applied, rejected, progressed, daysToReject, ghosted };
}

// Only abnormal patterns are defined; anything that trips none is green.
export function classify(records) {
  const ts = records.map(r => timeline(r)).filter(t => t.applied);
  if (!ts.length) return { level: 'green', reasons: [records.length ? '只有收藏，没有投递记录' : '没有投递记录'] };

  const fast1 = ts.filter(t => t.daysToReject !== null && t.daysToReject <= 1).length;
  const fast3 = ts.filter(t => t.daysToReject !== null && t.daysToReject <= 3).length;
  const rejected = ts.filter(t => t.rejected).length;
  const ghosted = ts.filter(t => t.ghosted).length;
  const progressed = ts.some(t => t.progressed);

  // Rejections and ghostings both count as "went nowhere".
  const dead = rejected + ghosted;
  const deadText = [rejected && `被拒 ${rejected} 次`, ghosted && `超过 ${GHOST_DAYS} 天无回复 ${ghosted} 次`]
    .filter(Boolean).join('、') + '，从未进 Screen';

  const red = [], yellow = [];
  if (fast1 >= 1) red.push(`1 天内被拒 ${fast1} 次`);
  if (fast3 >= 2) red.push(`3 天内被拒 ${fast3} 次`);
  if (dead >= 5 && !progressed) red.push(deadText);
  if (fast3 === 1) yellow.push('3 天内被拒 1 次');
  if (dead >= 3 && dead < 5 && !progressed) yellow.push(deadText);

  if (red.length && progressed) return { level: 'yellow', reasons: [...red, '曾进 Screen/面试，降为黄色'] };
  if (red.length) return { level: 'red', reasons: red };
  if (yellow.length) return { level: 'yellow', reasons: yellow };
  return { level: 'green', reasons: ['投过，未触发提醒规则'] };
}
