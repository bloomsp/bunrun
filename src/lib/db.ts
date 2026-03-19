export type Env = {
  DB: D1Database;
};

export function getEnv(locals: App.Locals | undefined): Env {
  // @ts-expect-error cloudflare runtime binding
  const runtime = (locals as any)?.runtime;
  const env = runtime?.env as Env | undefined;
  if (!env?.DB) {
    throw new Error('Missing D1 binding: DB');
  }
  return env;
}
