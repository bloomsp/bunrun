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

  // Default area selection when member is chosen
  const memberSel = form.querySelector('select[data-bunrun-member]');
  const areaSel = form.querySelector('select[data-bunrun-area]');
  if (memberSel && areaSel) {
    memberSel.addEventListener('change', () => {
      const opt = memberSel.options[memberSel.selectedIndex];
      const defArea = opt?.getAttribute('data-default-area') || '';
      if (defArea) areaSel.value = defArea;
    });
  }

  const updateAll = () => {
    normalizePair('start', 'am');
    normalizePair('end', 'pm');
  };

  const startHH = form.querySelector('input[name="startHH"]');
  const endHH = form.querySelector('input[name="endHH"]');

  // Update hidden fields whenever values change
  for (const el of form.querySelectorAll('input[name="startHH"],input[name="startMM"],input[name="endHH"],input[name="endMM"]')) {
    el.addEventListener('input', updateAll);
    el.addEventListener('change', updateAll);
    el.addEventListener('blur', updateAll);
  }

  // Update AM/PM badges: if hour is 13-23 show PM; otherwise show AM for start.
  const startMer = document.getElementById('startMer');
  const endMer = document.getElementById('endMer');

  const updateBadges = () => {
    const s = startHH ? Number(startHH.value) : NaN;
    if (startMer) {
      startMer.textContent = Number.isFinite(s) && s >= 12 ? 'PM' : 'AM';
    }
    const e = endHH ? Number(endHH.value) : NaN;
    if (endMer) {
      endMer.textContent = Number.isFinite(e) && e < 12 ? 'AM' : 'PM';
    }
  };

  if (startHH) startHH.addEventListener('input', updateBadges);
  if (endHH) endHH.addEventListener('input', updateBadges);

  // Tab out of End minutes -> focus Add Shift
  if (endMM && addBtn) {
    endMM.addEventListener('blur', () => {
      updateAll();
      if (typeof addBtn.focus === 'function') addBtn.focus();
    });
  }

  // Validate shift length client-side before submit (no overnight; max 10h; warn >9h)
  const warnElId = 'shiftWarn';
  let warnEl = document.getElementById(warnElId);
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.id = warnElId;
    warnEl.className = 'mt-3 text-sm';
    form.appendChild(warnEl);
  }

  const validate = () => {
    updateAll();
    updateBadges();

    const startOut = form.querySelector('input[data-time-out="start"]');
    const endOut = form.querySelector('input[data-time-out="end"]');
    const startVal = startOut ? startOut.value : '';
    const endVal = endOut ? endOut.value : '';

    const parse = (hhmm) => {
      const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };

    const s = parse(startVal);
    const e = parse(endVal);

    let msg = '';
    let type = '';

    // Clear custom validity by default
    const endMMInput = form.querySelector('input[name="endMM"]');
    if (endMMInput) endMMInput.setCustomValidity('');

    if (s != null && e != null) {
      const dur = e - s;
      if (dur <= 0) {
        msg = 'End time must be after start time (same day).';
        type = 'error';
        if (endMMInput) endMMInput.setCustomValidity(msg);
      } else if (dur > 10 * 60) {
        msg = 'Shift exceeds 10 hours max.';
        type = 'error';
        if (endMMInput) endMMInput.setCustomValidity(msg);
      } else if (dur > 9 * 60) {
        msg = 'Warning: long shift (> 9h).';
        type = 'warn';
      }
    }

    if (warnEl) {
      warnEl.textContent = msg;
      warnEl.className = type === 'error'
        ? 'mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900'
        : type === 'warn'
          ? 'mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900'
          : 'mt-3 text-sm text-slate-600';
    }

    return type !== 'error';
  };

  form.addEventListener('submit', (e) => {
    if (!validate()) {
      e.preventDefault();
      const endMMInput = form.querySelector('input[name="endMM"]');
      if (endMMInput && typeof endMMInput.reportValidity === 'function') endMMInput.reportValidity();
    }
  });

  // Run on load
  updateAll();
  updateBadges();

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
