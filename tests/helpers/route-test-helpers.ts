export class FakeStatement {
  sql: string;
  handlers: RouteDB;
  args: any[] = [];

  constructor(sql: string, handlers: RouteDB) {
    this.sql = sql;
    this.handlers = handlers;
  }

  bind(...args: any[]) {
    this.args = args;
    return this;
  }

  async first() {
    return this.handlers.first(this.sql, this.args);
  }

  async all() {
    return { results: await this.handlers.all(this.sql, this.args) };
  }

  async run() {
    return this.handlers.run(this.sql, this.args);
  }
}

export class RouteDB {
  firstHandlers = new Map<string, any>();
  allHandlers = new Map<string, any>();
  runs: Array<{ sql: string; args: any[] }> = [];
  batches: Array<Array<{ sql: string; args: any[] }>> = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }

  async first(sql: string, args: any[]) {
    const entry = [...this.firstHandlers.entries()].find(([key]) => sql.includes(key));
    if (!entry) return null;
    return typeof entry[1] === 'function' ? entry[1](args, sql) : entry[1];
  }

  async all(sql: string, args: any[]) {
    const entry = [...this.allHandlers.entries()].find(([key]) => sql.includes(key));
    if (!entry) return [];
    return typeof entry[1] === 'function' ? entry[1](args, sql) : entry[1];
  }

  async run(sql: string, args: any[]) {
    this.runs.push({ sql, args });
    return { meta: { changes: 1, last_row_id: 1 } };
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    return [];
  }
}

export function adminRequest(url: string, form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'bunrun_role=admin'
    },
    body
  });
}

export function installTestDB(db: RouteDB) {
  (globalThis as any).__bunrunTestDB = db;
}

export function installWorkBlockHooks(hooks: {
  recomputeWorkBlocksForSchedule?: (DB: D1Database, scheduleId: number) => Promise<void> | void;
  clearMemberBreakPlanForSchedule?: (DB: D1Database, scheduleId: number, memberId: number) => Promise<void> | void;
}) {
  (globalThis as any).__bunrunWorkBlockTestHooks = hooks;
}

export function resetRouteTestGlobals() {
  delete (globalThis as any).__bunrunTestDB;
  delete (globalThis as any).__bunrunWorkBlockTestHooks;
}
