export function renderTelemetryDashboardPage(nonce) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm Pi - Usage dashboard</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div><p class="eyebrow">SWARM PI / LOCAL TELEMETRY</p><h1>Usage dashboard</h1><p class="muted">A private view of completed Pi attempts on this machine.</p></div>
      <label class="period">Range <select id="range"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="0">All recorded</option></select></label>
    </header>
    <div id="status" class="notice" role="status">Loading report…</div>
    <section id="summary" class="cards" aria-label="Usage summary"></section>
    <section class="grid">
      <article class="panel"><div class="panel-heading"><div><p class="eyebrow">BREAKDOWN</p><h2>By model</h2></div></div><div id="models" class="bars"></div></article>
      <article class="panel"><div class="panel-heading"><div><p class="eyebrow">WORKFLOW</p><h2>By role</h2></div></div><div id="roles" class="bars"></div></article>
    </section>
    <section class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">DETAIL</p><h2>Recent attempts</h2></div><span id="cost" class="badge"></span></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Task / role</th><th>Model</th><th>Outcome</th><th>Duration</th><th>Tokens</th></tr></thead><tbody id="details"></tbody></table></div></section>
    <p class="footnote">Only bounded counters, safe labels, timestamps, outcomes, and durations are retained. Prompts, completions, paths, credentials, endpoints, Git data, and billing amounts are not shown.</p>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
const styles = `
:root { color-scheme: dark; --bg:#0b1020; --panel:#121a2d; --line:#26324b; --text:#eff4ff; --muted:#95a4c2; --accent:#8be9d1; --accent2:#9aa9ff; --warn:#f5c77a; }
* { box-sizing:border-box; } body { margin:0; min-height:100vh; background:radial-gradient(circle at 10% 0%,#182647 0%,transparent 42%),var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.shell { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:52px 0 40px; } .topbar { display:flex; justify-content:space-between; gap:24px; align-items:end; margin-bottom:28px; } h1,h2,p { margin:0; } h1 { font-size:clamp(2rem,4vw,3.6rem); letter-spacing:-.05em; } h2 { font-size:1.1rem; } .muted,.footnote { color:var(--muted); } .eyebrow { color:var(--accent); font-size:.72rem; font-weight:700; letter-spacing:.14em; margin-bottom:6px; } .period { color:var(--muted); display:grid; gap:4px; } select { background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--text); padding:9px 12px; font:inherit; }
.notice { border:1px solid var(--line); background:rgba(18,26,45,.85); border-radius:12px; color:var(--muted); padding:12px 14px; margin-bottom:18px; } .notice.error { border-color:#9d5562; color:#ffbdc8; } .notice.ok { border-color:#3d8979; color:var(--accent); }
.cards { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; } .card,.panel { background:rgba(18,26,45,.9); border:1px solid var(--line); border-radius:16px; } .card { padding:18px; min-height:112px; } .card-value { font-size:1.75rem; font-weight:700; margin:8px 0 2px; } .card-label { color:var(--muted); font-size:.84rem; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; } .panel { padding:20px; } .panel-heading { display:flex; justify-content:space-between; gap:16px; align-items:start; margin-bottom:18px; } .bars { display:grid; gap:13px; min-height:52px; } .bar-row { display:grid; gap:6px; } .bar-label { display:flex; justify-content:space-between; gap:12px; color:var(--muted); font-size:.87rem; } .bar-label strong { color:var(--text); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .track { background:#202b44; border-radius:999px; height:8px; overflow:hidden; } .fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:999px; min-width:3px; }
.detail-panel { padding-bottom:8px; } .badge { border:1px solid #5e6a83; border-radius:999px; color:var(--warn); font-size:.75rem; padding:4px 9px; white-space:nowrap; } .table-wrap { overflow-x:auto; } table { width:100%; border-collapse:collapse; min-width:720px; } th,td { border-bottom:1px solid var(--line); padding:12px 8px; text-align:left; white-space:nowrap; } th { color:var(--muted); font-size:.73rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; } td { font-size:.86rem; } td.outcome-succeeded { color:var(--accent); } td.outcome-failed,td.outcome-cancelled,td.outcome-timed-out { color:var(--warn); } .empty { color:var(--muted); padding:10px 0; } .footnote { font-size:.78rem; margin-top:18px; }
@media (max-width:760px) { .shell { width:min(100% - 24px,600px); padding-top:28px; } .topbar { align-items:start; flex-direction:column; } .cards { grid-template-columns:repeat(2,1fr); } .grid { grid-template-columns:1fr; } .card { min-height:98px; padding:14px; } }
`;
const script = `
const $ = (id) => document.getElementById(id);
const queryToken = new URLSearchParams(location.search).get("token") || "";
const range = $("range");
range.addEventListener("change", load);
load();
async function load() {
  const days = Number(range.value);
  const params = new URLSearchParams({ token: queryToken });
  if (days > 0) params.set("days", String(days));
  try {
    const response = await fetch("/api/telemetry/report?" + params.toString(), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("The local report could not be read.");
    render(await response.json());
  } catch (error) {
    $("status").textContent = error.message || "The local report could not be read.";
    $("status").className = "notice error";
  }
}
function render(report) {
  const summary = report.summary;
  $("status").textContent = report.health.status === "healthy" ? "Collector healthy · local-only" : "No complete telemetry history is available yet.";
  $("status").className = report.health.status === "healthy" ? "notice ok" : "notice";
  $("cost").textContent = "Cost: unavailable without pricing";
  $("summary").innerHTML = [
    card("Attempts", format(summary.attempts)), card("Successful", format(summary.succeeded)),
    card("Tokens", format(summary.inputTokens + summary.outputTokens)), card("Time", formatDuration(summary.durationMs))
  ].join("");
  renderBars("models", report.byModel); renderBars("roles", report.byRole);
  $("details").innerHTML = report.details.length ? report.details.map(detailRow).join("") : '<tr><td colspan="6" class="empty">No attempts recorded in this range.</td></tr>';
}
function card(label, value) { return '<article class="card"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div><div class="card-label">reported locally</div></article>'; }
function renderBars(id, buckets) {
  const max = Math.max(1, ...buckets.map((item) => item.attempts));
  $(id).innerHTML = buckets.length ? buckets.slice(0, 8).map((item) => '<div class="bar-row"><div class="bar-label"><strong title="' + text(item.key) + '">' + text(item.key) + '</strong><span>' + format(item.attempts) + '</span></div><div class="track"><div class="fill" style="width:' + Math.max(2, item.attempts / max * 100) + '%"></div></div></div>').join("") : '<div class="empty">No data yet.</div>';
}
function detailRow(item) {
  const tokens = item.usage ? format((item.usage.inputTokens || 0) + (item.usage.outputTokens || 0)) : "—";
  const outcome = item.context.outcome;
  return '<tr><td>' + new Date(item.recordedAt).toLocaleString() + '</td><td>' + text(item.context.taskKind) + ' · ' + text(item.context.role || "unassigned") + '</td><td>' + text(item.context.provider + "/" + item.context.model) + '</td><td class="outcome-' + text(outcome) + '">' + text(outcome) + '</td><td>' + formatDuration(item.context.durationMs) + '</td><td>' + tokens + '</td></tr>';
}
function format(value) { return new Intl.NumberFormat().format(value || 0); }
function formatDuration(value) { return value < 1000 ? value + " ms" : (value / 1000).toFixed(1) + " s"; }
function text(value) { return String(value).replace(/[&<>"']/g, (char) => char === '"' ? "&quot;" : ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;"}[char] || char)); }
`;
