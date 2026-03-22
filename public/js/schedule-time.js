function to2(n) {
  return String(n).padStart(2, '0');
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min || i > max) return null;
  return i;
}

function normalizePair(prefix, defaultMeridiem) {
  const hh = document.querySelector(`input[name="${prefix}HH"]`);
  const mm = document.querySelector(`input[name="${prefix}MM"]`);
  const out = document.querySelector(`input[data-time-out="${prefix}"]`);
  if (!hh || !mm || !out) return;

  const hhRaw = clampInt(hh.value, 0, 23);
  const mmRaw = clampInt(mm.value, 0, 59);
  if (hhRaw == null || mmRaw == null) {
    out.value = '';
    return;
  }

  // If hour is 13-23, treat as 24h regardless of default meridiem.
  // If hour is 0-12, interpret 1-12 with default AM/PM.
  let hh24 = hhRaw;
  if (hhRaw >= 0 && hhRaw <= 12) {
    const base = hhRaw % 12; // 12 -> 0
    if (defaultMeridiem === 'pm') hh24 = base + 12;
    else hh24 = base;
  }

  out.value = `${to2(hh24)}:${to2(mmRaw)}`;
}

function init() {
  const form = document.querySelector('form[action="/api/shifts/upsert"]');
  if (!form) return;

  const addBtn = document.querySelector('[data-bunrun-add-shift]');
  const endMM = form.querySelector('input[name="endMM"]');

  const updateAll = () => {
    normalizePair('start', 'am');
    normalizePair('end', 'pm');
  };

  // Update hidden fields whenever values change
  for (const el of form.querySelectorAll('input[name="startHH"],input[name="startMM"],input[name="endHH"],input[name="endMM"]')) {
    el.addEventListener('input', updateAll);
    el.addEventListener('change', updateAll);
    el.addEventListener('blur', updateAll);
  }

  // Tab out of End minutes -> focus Add Shift
  if (endMM && addBtn) {
    endMM.addEventListener('blur', () => {
      updateAll();
      if (typeof addBtn.focus === 'function') addBtn.focus();
    });
  }

  // Ensure hidden HH:MM values are set before submit
  form.addEventListener('submit', () => {
    updateAll();
  });

  updateAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
