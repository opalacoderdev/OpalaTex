// Safe localStorage helpers — silently swallow SecurityError / QuotaExceededError.

export const safeGetLocalStorage = (key, defaultValue) => {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : defaultValue;
  } catch (e) {
    return defaultValue;
  }
};

export const safeSetLocalStorage = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // ignore
  }
};
