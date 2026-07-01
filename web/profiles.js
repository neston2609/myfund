'use strict';

const fmtMoney = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const renameState = { slug: '', name: '' };

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

function toast(message, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, ms);
}

async function apiFetch(url, opts = {}) {
  const response = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderProfiles(profiles) {
  document.getElementById('profile-count').textContent = `${profiles.length} profiles`;
  const el = document.getElementById('profile-list');
  if (!profiles.length) {
    el.innerHTML = '<div class="card profile-card">ยังไม่มี profile · Create your first profile</div>';
    return;
  }

  el.innerHTML = profiles.map(profile => {
    const total = profile.portfolioTotals ?? {};
    return `<article class="profile-card">
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
      <div class="profile-actions">
        <a class="btn-outline profile-open" href="${esc(profile.url)}">เปิด Profile</a>
        <button class="btn-ghost" type="button" data-rename="${esc(profile.slug)}" data-name="${esc(profile.name)}">แก้ชื่อ</button>
      </div>
    </article>`;
  }).join('');

  el.querySelectorAll('[data-rename]').forEach(button => {
    button.addEventListener('click', () => openRenameModal(button.dataset.rename, button.dataset.name));
  });
}

async function loadProfiles() {
  const data = await apiFetch('/api/profiles');
  renderProfiles(data.profiles ?? []);
}

async function createProfile(event) {
  event.preventDefault();
  const input = document.getElementById('profile-name');
  const name = input.value.trim();
  if (!name) return;

  try {
    const profile = await apiFetch('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    window.location.href = profile.url;
  } catch (error) {
    toast('สร้าง profile ไม่สำเร็จ · ' + error.message);
  }
}

function openRenameModal(slug, currentName) {
  renameState.slug = slug;
  renameState.name = currentName;
  document.getElementById('rename-name').value = currentName;
  document.getElementById('rename-backdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('rename-name').focus(), 0);
}

function closeRenameModal() {
  document.getElementById('rename-backdrop').style.display = 'none';
  renameState.slug = '';
  renameState.name = '';
}

async function renameProfile(event) {
  event.preventDefault();
  const cleanName = document.getElementById('rename-name').value.trim();
  if (!cleanName || cleanName === renameState.name) {
    closeRenameModal();
    return;
  }

  try {
    const profile = await apiFetch(`/api/profiles/${encodeURIComponent(renameState.slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: cleanName }),
    });
    closeRenameModal();
    toast(`เปลี่ยนชื่อเป็น ${profile.name} แล้ว`);
    await loadProfiles();
  } catch (error) {
    toast('แก้ชื่อ profile ไม่สำเร็จ · ' + error.message, 4200);
  }
}

document.getElementById('profile-form').addEventListener('submit', createProfile);
document.getElementById('rename-form').addEventListener('submit', renameProfile);
document.getElementById('rename-close').addEventListener('click', closeRenameModal);
document.getElementById('rename-cancel').addEventListener('click', closeRenameModal);
document.getElementById('rename-backdrop').addEventListener('click', event => {
  if (event.target === document.getElementById('rename-backdrop')) closeRenameModal();
});
loadProfiles().catch(error => {
  document.getElementById('profile-list').innerHTML =
    `<div class="card profile-card">โหลด profile ไม่สำเร็จ · ${esc(error.message)}</div>`;
});
