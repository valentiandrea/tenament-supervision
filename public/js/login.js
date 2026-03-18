(function () {
  'use strict';

  const form      = document.getElementById('login-form');
  const errorBox  = document.getElementById('error-box');
  const submitBtn = document.getElementById('submit-btn');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('show');
  }
  function clearError() { errorBox.classList.remove('show'); }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearError();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) return showError('Please enter your username and password.');

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>Signing in\u2026';

    try {
      const res  = await fetch('/api/auth/login', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ username: username, password: password }),
        credentials: 'same-origin'
      });
      const data = await res.json();

      if (!data.success) {
        showError(data.error || 'Sign in failed.');
        return;
      }

      window.location.href = data.user.mustChangePassword ? '/change-password' : '/';
    } catch (_) {
      showError('Network error. Please try again.');
    } finally {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Sign In';
    }
  });

  // Silent check — redirect if already authenticated
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { if (r.ok) window.location.href = '/'; })
    .catch(function () {});
})();
