// Applies a saved manual theme choice before any CSS renders, so there's no
// flash of the wrong theme while React boots. Key/values must match
// src/theme.ts's THEME_STORAGE_KEY exactly — this script can't import that
// module, it has to run standalone before the bundle loads.
//
// Kept as a separate same-origin file (rather than inline in index.html) so
// the CSP's script-src can stay a plain 'self' instead of a content hash
// that would break every time this script's bytes changed.
(function () {
  try {
    var theme = localStorage.getItem("house-maintenance:theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    // localStorage can throw (private browsing, disabled storage); the
    // theme just falls back to CSS defaults in that case.
  }
})();
