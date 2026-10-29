// User preferences kept across app restarts (volume, subtitle style, transcribe options).
// localStorage can throw or be empty (cleared site data); every call falls back to the default.

const PREFIX = 'kathsub.';

export function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    // Merge objects so settings added in a newer version still get their default
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      return { ...fallback, ...value };
    }
    return value;
  } catch (_) {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (_) {
    // Not fatal: the setting just won't survive a restart
  }
}
