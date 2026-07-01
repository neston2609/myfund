'use strict';

const fmtMoney = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(value) {
  return 'THB ' + fmtMoney.format(Number(value || 0));
}

async function apiFetch(url) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderProfiles(profiles) {
  const el = document.getElementById('profile-list');
  if (!profiles.length) {
    el.innerHTML = '<div class="card profile-card">ยังไม่มี profile</div>';
    return;
  }

  el.innerHTML = profiles.map(profile => {
    const total = profile.portfolioTotals ?? {};
    return `<a class="profile-card profile-card-link" href="${esc(profile.url)}">
      <div class="profile-card-top">
        <div>
          <div class="profile-name">${esc(profile.name)}</div>
          <div class="profile-slug">/${esc(profile.slug)}</div>
        </div>
        <span class="fund-type-badge">${profile.funds} funds</span>
      </div>
      <div class="profile-total">${fmt(total.currentValue)}</div>
      <div class="profile-stats">
        <span>${profile.holdings} lots</span>
        <span class="${Number(total.gain || 0) >= 0 ? 'positive-text' : 'negative-text'}">${fmt(total.gain)}</span>
      </div>
    </a>`;
  }).join('');
}

async function loadProfiles() {
  const data = await apiFetch('/api/profiles');
  renderProfiles(data.profiles ?? []);
}

loadProfiles().catch(error => {
  document.getElementById('profile-list').innerHTML =
    `<div class="card profile-card">โหลด profile ไม่สำเร็จ · ${esc(error.message)}</div>`;
});
