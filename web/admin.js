'use strict';

const fmtMoney = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const S = { password: '', deleteSlug: '', deleteName: '' };

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

function toast(message, ms = 3200) {
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadProfiles() {
  const data = await apiFetch('/api/profiles');
  renderAdminProfiles(data.profiles ?? []);
}

async function loadSmtpConfig() {
  const smtp = await apiFetch('/api/admin/smtp');
  document.getElementById('smtp-enabled').checked = Boolean(smtp.enabled);
  document.getElementById('smtp-host').value = smtp.host || 'smtp.gmail.com';
  document.getElementById('smtp-port').value = smtp.port || 587;
  document.getElementById('smtp-secure').checked = Boolean(smtp.secure);
  document.getElementById('smtp-user').value = smtp.user || '';
  document.getElementById('smtp-from').value = smtp.from || '';
  document.getElementById('smtp-password').placeholder = smtp.hasPassword
    ? 'ตั้งค่าไว้แล้ว · เว้นว่างไว้ถ้าไม่เปลี่ยน'
    : 'Gmail App Password';
}

function renderAdminProfiles(profiles) {
  const el = document.getElementById('admin-profile-list');
  if (!profiles.length) {
    el.innerHTML = '<div class="profile-muted">ยังไม่มี profile</div>';
    return;
  }

  el.innerHTML = profiles.map(profile => {
    const total = profile.portfolioTotals ?? {};
    return `<div class="admin-profile-row" data-profile="${esc(profile.slug)}">
      <div class="admin-profile-main">
        <input class="admin-profile-name-input" value="${esc(profile.name)}" aria-label="Profile name">
        <div class="profile-slug">/${esc(profile.slug)} · ${profile.funds} funds · ${profile.holdings} lots · ${fmt(total.currentValue)}</div>
      </div>
      <div class="admin-profile-actions">
        <a class="btn-outline nav-link" href="${esc(profile.url)}">เปิด</a>
        <button class="btn-save" type="button" data-save="${esc(profile.slug)}">บันทึกชื่อ</button>
        <button class="btn-danger" type="button" data-delete="${esc(profile.slug)}" data-name="${esc(profile.name)}">ลบ</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-save]').forEach(button => {
    button.addEventListener('click', () => renameProfile(button.dataset.save));
  });
  el.querySelectorAll('[data-delete]').forEach(button => {
    button.addEventListener('click', () => openDeleteModal(button.dataset.delete, button.dataset.name));
  });
}

async function login(event) {
  event.preventDefault();
  const password = document.getElementById('admin-password').value;
  try {
    await apiFetch('/api/admin/verify', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    S.password = password;
    document.getElementById('current-admin-password').value = password;
    document.getElementById('login-card').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'flex';
    await loadProfiles();
    await loadSmtpConfig();
    toast('เข้าสู่ระบบแล้ว');
  } catch (error) {
    toast('รหัสผ่านไม่ถูกต้อง · ' + error.message);
  }
}

async function createProfile(event) {
  event.preventDefault();
  const input = document.getElementById('admin-profile-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    await apiFetch('/api/admin/profiles', {
      method: 'POST',
      body: JSON.stringify({ password: S.password, name }),
    });
    input.value = '';
    await loadProfiles();
    toast('เพิ่ม profile แล้ว');
  } catch (error) {
    toast('เพิ่ม profile ไม่สำเร็จ · ' + error.message, 4200);
  }
}

async function renameProfile(slug) {
  const row = document.querySelector(`[data-profile="${CSS.escape(slug)}"]`);
  const name = row?.querySelector('.admin-profile-name-input')?.value.trim();
  if (!name) return;
  try {
    await apiFetch(`/api/admin/profiles/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: S.password, name }),
    });
    await loadProfiles();
    toast('บันทึกชื่อ profile แล้ว');
  } catch (error) {
    toast('บันทึกชื่อไม่สำเร็จ · ' + error.message, 4200);
  }
}

function openDeleteModal(slug, name) {
  S.deleteSlug = slug;
  S.deleteName = name;
  document.getElementById('delete-hint').textContent = `กำลังจะลบ "${name}" ข้อมูล profile นี้จะถูกลบออกจากระบบ`;
  document.getElementById('delete-password').value = '';
  document.getElementById('delete-backdrop').style.display = 'flex';
  setTimeout(() => document.getElementById('delete-password').focus(), 0);
}

function closeDeleteModal() {
  document.getElementById('delete-backdrop').style.display = 'none';
  S.deleteSlug = '';
  S.deleteName = '';
}

async function deleteProfile(event) {
  event.preventDefault();
  const password = document.getElementById('delete-password').value;
  try {
    await apiFetch(`/api/admin/profiles/${encodeURIComponent(S.deleteSlug)}`, {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    closeDeleteModal();
    await loadProfiles();
    toast('ลบ profile แล้ว');
  } catch (error) {
    toast('ลบ profile ไม่สำเร็จ · ' + error.message, 4200);
  }
}

async function changePassword(event) {
  event.preventDefault();
  const password = document.getElementById('current-admin-password').value;
  const newPassword = document.getElementById('new-admin-password').value;
  try {
    await apiFetch('/api/admin/password', {
      method: 'PATCH',
      body: JSON.stringify({ password, newPassword }),
    });
    S.password = newPassword;
    document.getElementById('admin-password').value = newPassword;
    document.getElementById('current-admin-password').value = newPassword;
    document.getElementById('new-admin-password').value = '';
    toast('เปลี่ยน admin password แล้ว');
  } catch (error) {
    toast('เปลี่ยนรหัสผ่านไม่สำเร็จ · ' + error.message, 4200);
  }
}

async function saveSmtp(event) {
  event.preventDefault();
  const smtp = {
    enabled: document.getElementById('smtp-enabled').checked,
    host: document.getElementById('smtp-host').value.trim(),
    port: Number(document.getElementById('smtp-port').value),
    secure: document.getElementById('smtp-secure').checked,
    user: document.getElementById('smtp-user').value.trim(),
    from: document.getElementById('smtp-from').value.trim(),
    password: document.getElementById('smtp-password').value,
  };

  try {
    await apiFetch('/api/admin/smtp', {
      method: 'PUT',
      body: JSON.stringify({ password: S.password, smtp }),
    });
    document.getElementById('smtp-password').value = '';
    await loadSmtpConfig();
    toast('บันทึก SMTP แล้ว');
  } catch (error) {
    toast('บันทึก SMTP ไม่สำเร็จ · ' + error.message, 5200);
  }
}

async function sendTestEmail(event) {
  event.preventDefault();
  const to = document.getElementById('smtp-test-to').value.trim();
  try {
    await apiFetch('/api/admin/smtp/test', {
      method: 'POST',
      body: JSON.stringify({
        password: S.password,
        to,
        subject: 'MyFund SMTP test',
        text: 'This is a test email from MyFund.',
      }),
    });
    toast('ส่ง test email แล้ว');
  } catch (error) {
    toast('ส่ง test email ไม่สำเร็จ · ' + error.message, 6500);
  }
}

document.getElementById('admin-login-form').addEventListener('submit', login);
document.getElementById('admin-create-form').addEventListener('submit', createProfile);
document.getElementById('admin-password-form').addEventListener('submit', changePassword);
document.getElementById('smtp-form').addEventListener('submit', saveSmtp);
document.getElementById('smtp-test-form').addEventListener('submit', sendTestEmail);
document.getElementById('delete-form').addEventListener('submit', deleteProfile);
document.getElementById('delete-close').addEventListener('click', closeDeleteModal);
document.getElementById('delete-cancel').addEventListener('click', closeDeleteModal);
document.getElementById('delete-backdrop').addEventListener('click', event => {
  if (event.target === document.getElementById('delete-backdrop')) closeDeleteModal();
});
