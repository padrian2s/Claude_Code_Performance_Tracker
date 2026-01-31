const https = require('https');
const fs = require('fs');

const SOURCE_URL = 'https://marginlab.ai/trackers/claude-code/';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-perf-tracker/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractData(html) {
  let daily = null, weekly = null, baseline = null;

  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of scriptBlocks) {
    const content = block.replace(/<\/?script[^>]*>/gi, '');

    for (const m of content.matchAll(/(\[\s*\{[^[\]]*"date"\s*:[^[\]]*"passRate"\s*:[^[\]]*\}\s*\])/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed.length && parsed[0].date && parsed[0].passRate !== undefined) {
          if (!daily || parsed.length > daily.length) daily = parsed;
        }
      } catch {}
    }

    for (const m of content.matchAll(/(\[\s*\{[^[\]]*"startDate"\s*:[^[\]]*"passRate"\s*:[^[\]]*\}\s*\])/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed.length && parsed[0].startDate) {
          if (!weekly || parsed.length > weekly.length) weekly = parsed;
        }
      } catch {}
    }
  }

  const bm = html.match(/baseline[^=]*=\s*([\d.]+)/i) || html.match(/baselinePassRate[^=]*=\s*([\d.]+)/i);
  if (bm) baseline = parseFloat(bm[1]);

  return { daily, weekly, baseline };
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildRSS(data) {
  const { daily, weekly, baseline } = data;
  const now = new Date().toUTCString();
  const items = [];

  if (daily) {
    const sorted = [...daily].sort((a, b) => b.date.localeCompare(a.date));
    for (const e of sorted) {
      const d = new Date(e.date + 'T12:00:00Z');
      const rate = Math.round(e.passRate * 100) / 100;
      const change = baseline ? (rate - Math.round(baseline)).toFixed(1) : null;
      const changeStr = change !== null ? ` (${change >= 0 ? '+' : ''}${change}% vs baseline)` : '';
      const title = `Claude Code: ${rate}% pass rate on ${e.date}${changeStr}`;
      const desc = [
        `Pass Rate: ${rate}%`,
        `CI: ${e.ciLower?.toFixed(1)}% - ${e.ciUpper?.toFixed(1)}%`,
        `Evaluations: ${e.runsCount} | Passed: ${e.passed}`,
        baseline ? `Baseline: ${Math.round(baseline)}%` : '',
        change !== null ? `Change: ${change >= 0 ? '+' : ''}${change}%` : '',
      ].filter(Boolean).join('\n');

      items.push(`    <item>
      <title>${esc(title)}</title>
      <link>${esc(SOURCE_URL)}</link>
      <guid isPermaLink="false">claude-code-daily-${e.date}</guid>
      <pubDate>${d.toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
      <category>daily</category>
    </item>`);
    }
  }

  if (weekly) {
    const sorted = [...weekly].sort((a, b) => b.startDate.localeCompare(a.startDate));
    for (const e of sorted) {
      const d = new Date(e.endDate + 'T12:00:00Z');
      const title = `Claude Code Weekly: ${e.passRate}% (${e.dateRange})`;
      const desc = [
        `Weekly Pass Rate: ${e.passRate}%`,
        `Period: ${e.dateRange}`,
        `CI: ${e.ciLower?.toFixed(1)}% - ${e.ciUpper?.toFixed(1)}%`,
        `Evaluations: ${e.runsCount}`,
      ].filter(Boolean).join('\n');

      items.push(`    <item>
      <title>${esc(title)}</title>
      <link>${esc(SOURCE_URL)}</link>
      <guid isPermaLink="false">claude-code-weekly-${e.startDate}</guid>
      <pubDate>${d.toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
      <category>weekly</category>
    </item>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Claude Code Performance Tracker</title>
    <link>${esc(SOURCE_URL)}</link>
    <description>Daily and weekly performance tracking for Claude Code (Opus 4.5) on SWE-Bench Pro tasks. Data from MarginLab.</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <docs>Generated on ${now}</docs>
    <generator>claude-perf-tracker</generator>
    <item>
      <title>Feed generated: ${now}</title>
      <link>${esc(SOURCE_URL)}</link>
      <guid isPermaLink="false">claude-code-execution-${new Date().toISOString()}</guid>
      <pubDate>${now}</pubDate>
      <description>This RSS feed was generated on ${now}.</description>
      <category>meta</category>
    </item>
${items.join('\n')}
  </channel>
</rss>`;
}

async function main() {
  console.log('Fetching data from', SOURCE_URL);
  const html = await fetch(SOURCE_URL);
  const data = extractData(html);

  if (!data.daily || data.daily.length === 0) {
    console.error('ERROR: Could not extract daily data. Page structure may have changed.');
    process.exit(1);
  }

  console.log(`Extracted ${data.daily.length} daily, ${data.weekly?.length || 0} weekly entries`);

  const rss = buildRSS(data);
  fs.writeFileSync('feed.xml', rss);
  console.log('Written feed.xml');

  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
  console.log('Written data.json');
}

main().catch(err => { console.error(err); process.exit(1); });
