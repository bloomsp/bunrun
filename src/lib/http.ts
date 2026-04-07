export function isISODate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function getString(form: FormData, key: string, fallback = ''): string {
  return (form.get(key) ?? fallback).toString();
}

export function getTrimmedString(form: FormData, key: string, fallback = ''): string {
  return getString(form, key, fallback).trim();
}

export function getPositiveInt(form: FormData, key: string): number | null {
  const value = Number(form.get(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function getOptionalPositiveInt(form: FormData, key: string): number | null | undefined {
  const raw = getTrimmedString(form, key);
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function getReturnTo(form: FormData, fallback: string): string {
  const value = getTrimmedString(form, 'returnTo', fallback);
  return value || fallback;
}

export function getUniquePositiveInts(form: FormData, key: string, limit?: number): number[] {
  const values = form.getAll(key)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const unique = [...new Set(values)];
  return typeof limit === 'number' ? unique.slice(0, limit) : unique;
}
