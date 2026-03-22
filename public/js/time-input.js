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
  for (const input of inputs) {
    input.addEventListener('blur', () => {
      const def = input.getAttribute('data-default-meridiem') || 'am';
      const normalized = parse(input.value, def);
      if (normalized) input.value = normalized;
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
