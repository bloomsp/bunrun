export type ShiftRole = 'normal' | 'floater' | 'breaks';

export function normalizeShiftRole(value: unknown): ShiftRole {
  return value === 'floater' || value === 'breaks' ? value : 'normal';
}

export function shiftRoleLabel(role: string | null | undefined) {
  switch (normalizeShiftRole(role)) {
    case 'floater':
      return 'Floater';
    case 'breaks':
      return 'Breaks';
    default:
      return 'Normal';
  }
}

export function isBreaksRole(role: string | null | undefined) {
  return normalizeShiftRole(role) === 'breaks';
}
