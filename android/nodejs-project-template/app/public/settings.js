// Theme preference: purely client-side (localStorage), no server round-trip needed.
// The actual early application (to avoid a flash on load) happens in
// partials/theme-init.ejs, which runs in <head> on every page; this just wires up
// the select control here and keeps it in sync going forward.
(function () {
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    if (select) {
      select.value = localStorage.getItem('theme') || 'system';

      select.addEventListener('change', () => {
        const theme = select.value;
        if (theme === 'system') {
          localStorage.removeItem('theme');
        } else {
          localStorage.setItem('theme', theme);
        }
        applyTheme(theme);
      });
    }

    // Language is server-rendered (all app-chrome text comes from EJS via res.locals.t),
    // so unlike theme it can't just flip a CSS variable -- changing it has to reload the
    // page so the server re-renders in the new language. The select's initial value is
    // already set server-side (see settings.ejs), matching the current "lang" cookie.
    const languageSelect = document.getElementById('language-select');
    if (languageSelect) {
      languageSelect.addEventListener('change', () => {
        document.cookie = 'lang=' + languageSelect.value + ';path=/;max-age=31536000';
        location.reload();
      });
    }
  });
})();
