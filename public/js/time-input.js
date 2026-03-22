function toHHMM(minutes) {
  const hh = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function parse(input, defaultMeridiem) {
  let v = (input || '').trim().toLowerCase();
  if (!v) return null;

  let mer = null;
  if (v.endsWith('am')) {
    mer = 'am';
    v = v.slice(0, -2).trim();
  } else if (v.endsWith('pm')) {
    mer = 'pm';
    v = v.slice(0, -2).trim();
  }

  // digits only
  if (/^\d{1,4}$/.test(v)) {
    let hh, mm;
    if (v.length <= 2) {
      hh = Number(v);
      mm = 0;
    } else {
      hh = Number(v.slice(0, -2));
      mm = Number(v.slice(-2));
    }
    if (mm < 0 || mm > 59) return null;

    if (hh >= 13 && hh <= 23 && mer === null) {
      return toHHMM(hh * 60 + mm);
    }

    const md = mer || defaultMeridiem;
    if (hh < 0 || hh > 12) return null;
    let hh24 = hh % 12;
    if (md === 'pm') hh24 += 12;
    return toHHMM(hh24 * 60 + mm);
  }

  const m = /^(\d{1,2})(?::(\d{0,2}))?$/.exec(v);
  if (m) {
    const hh = Number(m[1]);
    const mmStr = m[2] || '';
    const mm = mmStr === '' ? 0 : Number(mmStr.padEnd(2, '0'));
    if (mm < 0 || mm > 59) return null;

    if (hh >= 13 && hh <= 23 && mer === null) {
      return toHHMM(hh * 60 + mm);
    }

    const md = mer || defaultMeridiem;
    if (hh < 0 || hh > 12) return null;
    let hh24 = hh % 12;
    if (md === 'pm') hh24 += 12;
    return toHHMM(hh24 * 60 + mm);
  }

  return null;
}

function init() {
  const inputs = document.querySelectorAll('input[data-bunrun-time]');

  const normalizeInput = (input) => {
    const def = input.getAttribute('data-default-meridiem') || 'am';
    const normalized = parse(input.value, def);
    if (normalized) input.value = normalized;
    return normalized;
  };

  for (const input of inputs) {
    // Normalize when leaving the field (Safari is more reliable with focusout/change than keydown Tab).
    input.addEventListener('focusout', () => {
      normalizeInput(input);

      // If this is the End time field, move focus to the Add Shift button for quick Enter.
      if (input.name === 'endTime') {
        const btn = document.querySelector('[data-bunrun-add-shift]');
        if (btn && typeof btn.focus === 'function') btn.focus();
      }
    });

    input.addEventListener('change', () => {
      normalizeInput(input);
    });

    // Best-effort: normalize on Tab keydown (works in most Chromium cases)
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      normalizeInput(input);
    });
  }

  // Normalize before submitting the Add Shift form (most reliable across browsers)
  const addShiftForm = document.querySelector('form[action="/api/shifts/upsert"]');
  if (addShiftForm) {
    addShiftForm.addEventListener('submit', (e) => {
      const start = addShiftForm.querySelector('input[name="startTime"]');
      const end = addShiftForm.querySelector('input[name="endTime"]');
      if (start) normalizeInput(start);
      if (end) normalizeInput(end);

      // Provide nicer client-side feedback if parsing fails.
      if (start && !parse(start.value, start.getAttribute('data-default-meridiem') || 'am')) {
        start.setCustomValidity('Please enter a valid time (e.g. 6, 6:00, 18:30).');
      } else if (start) {
        start.setCustomValidity('');
      }

      if (end && !parse(end.value, end.getAttribute('data-default-meridiem') || 'pm')) {
        end.setCustomValidity('Please enter a valid time (e.g. 3, 3:00, 15:30).');
      } else if (end) {
        end.setCustomValidity('');
      }

      // Let the browser show validity UI if needed.
      if (start && !start.checkValidity()) {
        e.preventDefault();
        start.reportValidity();
        return;
      }
      if (end && !end.checkValidity()) {
        e.preventDefault();
        end.reportValidity();
        return;
      }
    });
  }

  // Default area selection when member is chosen
  const memberSel = document.querySelector('select[data-bunrun-member]');
  const areaSel = document.querySelector('select[data-bunrun-area]');
  if (memberSel && areaSel) {
    memberSel.addEventListener('change', () => {
      const opt = memberSel.options[memberSel.selectedIndex];
      const defArea = opt?.getAttribute('data-default-area') || '';
      if (defArea) areaSel.value = defArea;
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
