export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, total_cents INTEGER NOT NULL);`;
export class OrderRepository { public findOrderById(id: string) { return { id, totalCents: 4500 }; } }
