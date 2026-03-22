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
  // Assemble HH:MM values from hour-only inputs for the Add Shift form.
  const addShiftForm = document.querySelector('form[action="/api/shifts/upsert"]');
  if (addShiftForm) {
    const startHour = addShiftForm.querySelector('input[name="startHour"]');
    const endHour = addShiftForm.querySelector('input[name="endHour"]');
    const startTime = addShiftForm.querySelector('input[name="startTime"]');
    const endTime = addShiftForm.querySelector('input[name="endTime"]');
    const addBtn = document.querySelector('[data-bunrun-add-shift]');

    const to2 = (n) => String(n).padStart(2, '0');

    const writeTimes = () => {
      if (startHour && startTime) {
        const h = Number(startHour.value);
        if (Number.isFinite(h)) startTime.value = `${to2(h)}:00`;
      }
      if (endHour && endTime) {
        const hRaw = Number(endHour.value);
        if (Number.isFinite(hRaw)) {
          // End defaults to PM for 1-12
          let h = hRaw;
          if (h >= 1 && h <= 12) h = (h % 12) + 12;
          endTime.value = `${to2(h)}:00`;
        }
      }
    };

    if (endHour && addBtn) {
      endHour.addEventListener('blur', () => {
        writeTimes();
        if (typeof addBtn.focus === 'function') addBtn.focus();
      });
    }

    addShiftForm.addEventListener('submit', () => {
      writeTimes();
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
