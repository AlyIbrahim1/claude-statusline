// ── Theme toggle ──
const toggle = document.getElementById('themeToggle');
const html = document.documentElement;
html.setAttribute('data-theme', localStorage.getItem('theme') || 'dark');
toggle.addEventListener('click', () => {
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
});

// ── Formatting helpers ──
function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}

function fmtDuration(s) {
    s = Number(s) || 0;
    if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    if (s >= 60) return `${Math.floor(s / 60)}m`;
    return `${s}s`;
}

// ── Render rows from SESSIONS_DATA ──
const tbody      = document.getElementById('tableBody');
const filterEl   = document.getElementById('projectFilter');
const statSessions = document.getElementById('statSessions');
const statTokIn    = document.getElementById('statTokIn');
const statTokOut   = document.getElementById('statTokOut');
const statCost     = document.getElementById('statCost');

// Populate project filter options from data
const projectNames = [...new Set(SESSIONS_DATA.map(s => s.project_name))].sort();
projectNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    filterEl.appendChild(opt);
});

// Badge class mapping
function badgeClass(reason) {
    return { normal: 'reason-badge normal', interrupt: 'reason-badge interrupt', pending: 'reason-badge pending' }[reason] ?? 'reason-badge unknown';
}

// Build table rows
SESSIONS_DATA.forEach(s => {
    const isPending = s.exit_reason === 'pending';
    const dash = '\u2014';

    const tr = document.createElement('tr');
    tr.dataset.project = s.project_name;
    tr.dataset.tokIn   = isPending ? '0' : String(s.tokens_in);
    tr.dataset.tokOut  = isPending ? '0' : String(s.tokens_out);
    tr.dataset.cost    = isPending ? '0' : String(s.cost_usd);
    tr.dataset.pending = isPending ? '1' : '0';

    tr.innerHTML = `
        <td><span class="tag">${s.project_name}</span></td>
        <td class="col-model">${s.model}</td>
        <td class="col-ts">${s.start_time}</td>
        <td class="col-dur">${isPending ? dash : fmtDuration(s.duration_seconds)}</td>
        <td class="col-tok">${isPending ? dash : fmtTokens(s.tokens_in)}</td>
        <td class="col-tok">${isPending ? dash : fmtTokens(s.tokens_out)}</td>
        <td class="col-cost">${isPending ? dash : '$' + Number(s.cost_usd).toFixed(4)}</td>
        <td><span class="${badgeClass(s.exit_reason)}">${s.exit_reason}</span></td>
    `;
    tbody.appendChild(tr);
});

if (SESSIONS_DATA.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:48px 20px;color:var(--text-3);font-size:13px;">No sessions recorded yet</td></tr>';
}

// ── Filter + stats ──
function applyFilter() {
    const val = filterEl.value;
    const rows = tbody.querySelectorAll('tr[data-project]');
    let sessions = 0, tokIn = 0, tokOut = 0, cost = 0, visible = 0;

    rows.forEach(row => {
        const match = !val || row.dataset.project === val;
        row.classList.toggle('hidden', !match);
        if (match) {
            visible++;
            if (row.dataset.pending !== '1') {
                sessions++;
                tokIn  += Number(row.dataset.tokIn)  || 0;
                tokOut += Number(row.dataset.tokOut) || 0;
                cost   += Number(row.dataset.cost)   || 0;
            }
        }
    });

    statSessions.textContent = sessions;
    statTokIn.textContent    = fmtTokens(tokIn);
    statTokOut.textContent   = fmtTokens(tokOut);
    statCost.textContent     = '$' + cost.toFixed(2);
}

filterEl.addEventListener('change', applyFilter);
applyFilter(); // run on load to set initial stats