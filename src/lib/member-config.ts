export const BREAK_PREFERENCES = ['15+30', '30+15', '30+30'] as const;

export type BreakPreference = (typeof BREAK_PREFERENCES)[number];

export function isBreakPreference(value: string): value is BreakPreference {
  return BREAK_PREFERENCES.includes(value as BreakPreference);
}
