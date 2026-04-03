function initShiftForm(form) {
  if (!form) return;

  const memberSel = form.querySelector('select[data-bunrun-member]');
  const areaSel = form.querySelector('select[data-bunrun-area]');
  if (memberSel && areaSel) {
    memberSel.addEventListener('change', () => {
      const opt = memberSel.options[memberSel.selectedIndex];
      const defArea = opt?.getAttribute('data-default-area') || '';
      if (defArea) areaSel.value = defArea;
    });
  }

  const endTime = form.querySelector('input[data-bunrun-endtime]');
  const addBtn = form.querySelector('[data-bunrun-add-shift]');
  if (endTime && addBtn) {
    endTime.addEventListener('blur', () => {
      if (typeof addBtn.focus === 'function') addBtn.focus();
    });
  }

  const computedEl = form.querySelector('[data-shift-computed]') || form.querySelector('#shiftComputed');

  const parse = (hhmm) => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const fmt = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  };

  const showMessage = (msg, kind) => {
    let warnEl = form.querySelector('[data-shiftWarn]');
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.setAttribute('data-shiftWarn', '');
      warnEl.className = 'mt-3 text-sm';
      form.appendChild(warnEl);
    }

    warnEl.textContent = msg || '';
    warnEl.className = kind === 'error'
      ? 'mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900'
      : kind === 'warn'
        ? 'mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900'
        : 'mt-3 text-sm text-slate-600';
  };

  const validate = () => {
    const startVal = form.querySelector('input[name="startTime"]')?.value || '';
    const endVal = form.querySelector('input[name="endTime"]')?.value || '';

    const s = parse(startVal);
    const e = parse(endVal);

    if (computedEl) {
      if (s != null && e != null) {
        const dur = e - s;
        computedEl.textContent = `Computed: ${startVal} → ${endVal} (${fmt(Math.max(dur, 0))})`;
      } else {
        computedEl.textContent = '';
      }
    }

    // clear any prior custom validity
    const endInput = form.querySelector('input[name="endTime"]');
    if (endInput) endInput.setCustomValidity('');

    if (s != null && e != null) {
      const dur = e - s;
      if (dur <= 0) {
        const msg = 'End time must be after start time (same day).';
        showMessage(msg, 'error');
        if (endInput) endInput.setCustomValidity(msg);
        return false;
      }
      if (dur > 10 * 60) {
        const msg = 'Shift exceeds 10 hours max.';
        showMessage(msg, 'error');
        if (endInput) endInput.setCustomValidity(msg);
        return false;
      }
      if (dur > 9 * 60) {
        showMessage('Warning: long shift (> 9h).', 'warn');
        return true;
      }
    }

    showMessage('', '');
    return true;
  };

  // Update computed line as user edits
  form.querySelector('input[name="startTime"]')?.addEventListener('input', validate);
  form.querySelector('input[name="endTime"]')?.addEventListener('input', validate);

  form.addEventListener('submit', (e) => {
    if (!validate()) {
      e.preventDefault();
      const endInput = form.querySelector('input[name="endTime"]');
      if (endInput && typeof endInput.reportValidity === 'function') endInput.reportValidity();
    }
  });

  validate();
}

function init() {
  document.querySelectorAll('form[data-shift-form]').forEach((form) => initShiftForm(form));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
