/* eslint-disable @typescript-eslint/no-require-imports */

function makeDbMock(vi) {
  const queues = new Map();
  const captured = { values: new Map() };
  const key = (op, t) => `${op}:${t ?? "*"}`;

  function nextResult(op, t) {
    const q = queues.get(key(op, t));
    if (q && q.length > 0) return q.shift();
    const def = queues.get(key(op));
    if (def && def.length > 0) return def.shift();
    return [];
  }

  function setResult(op, t, result) {
    const k = key(op, t);
    const q = queues.get(k) ?? [];
    q.push(result);
    queues.set(k, q);
  }

  function tableName(t) {
    if (!t) return undefined;
    if (typeof t === "string") return t;
    const sym = Symbol.for("drizzle:Name");
    if (t[sym]) return t[sym];
    if (t?._?.name) return t._.name;
    if (t?._?.config?.name) return t._.config.name;
    return undefined;
  }

  function makeChain(op, t) {
    const chain = {
      values: (v) => {
        const k = key(op, t);
        const arr = captured.values.get(k) ?? [];
        arr.push(v);
        captured.values.set(k, arr);
        return chain;
      },
      set: () => chain,
      from: (table) => makeChain(op, tableName(table) ?? t),
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      returning: () => chain,
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(nextResult(op, t)).then(onFulfilled, onRejected),
      catch: (onRejected) => Promise.resolve(nextResult(op, t)).catch(onRejected),
      finally: (cb) => Promise.resolve(nextResult(op, t)).finally(cb),
    };
    return chain;
  }

  const db = {
    insert: vi.fn((t) => makeChain("insert", tableName(t))),
    select: vi.fn(() => makeChain("select")),
    update: vi.fn((t) => makeChain("update", tableName(t))),
    delete: vi.fn((t) => makeChain("delete", tableName(t))),
    query: {},
  };

  return {
    db,
    queueSelect: (table, result) => setResult("select", table, result),
    queueInsert: (table, result) => setResult("insert", table, result),
    queueUpdate: (table, result) => setResult("update", table, result),
    queueDelete: (table, result) => setResult("delete", table, result),
    lastInsertValues: (table) => {
      const arr = captured.values.get(key("insert", table)) ?? [];
      return arr[arr.length - 1];
    },
    clearCaptured: () => {
      captured.values.clear();
    },
  };
}

function makeStripeMock(vi) {
  return {
    customers: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      list: vi.fn(),
      listBalanceTransactions: vi.fn(),
    },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() } },
    paymentIntents: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
    events: { list: vi.fn() },
  };
}

module.exports = { makeDbMock, makeStripeMock };
