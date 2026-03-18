(function () {
  'use strict';

  const form  = document.getElementById('form');
  const msgEl = document.getElementById('msg');
  const btn   = document.getElementById('btn');

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className   = 'msg ' + type;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const current = document.getElementById('current').value;
    const newpw   = document.getElementById('newpw').value;
    const confirm = document.getElementById('confirm').value;
    if (newpw !== confirm) return showMsg('New passwords do not match.', 'error');

    btn.disabled    = true;
    btn.textContent = 'Saving\u2026';

    try {
      const res  = await fetch('/api/auth/change-password', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ currentPassword: current, newPassword: newpw }),
        credentials: 'same-origin'
      });
      const data = await res.json();
      if (!data.success) return showMsg(data.error, 'error');
      showMsg('Password updated. Redirecting to login\u2026', 'success');
      setTimeout(function () { window.location.href = '/login'; }, 1800);
    } catch (_) {
      showMsg('Network error. Please try again.', 'error');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Update Password';
    }
  });
})();
