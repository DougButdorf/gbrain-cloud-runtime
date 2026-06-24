'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let postgresModule;

function loadPostgres() {
  if (postgresModule) return postgresModule;
  try {
    postgresModule = require('postgres');
  } catch {
    postgresModule = require(process.env.GBRAIN_POSTGRES_MODULE || '/Users/landokeynes/gbrain/node_modules/postgres');
  }
  if (postgresModule && typeof postgresModule !== 'function' && typeof postgresModule.default === 'function') {
    postgresModule = postgresModule.default;
  }
  return postgresModule;
}

function enabledFromEnv() {
  return process.env.GBRAIN_COLLECTOR_STATE_ENABLED === '1' || process.env.GBRAIN_COLLECTOR_STATE_BACKEND === 'postgres';
}

function makeRunId(prefix = 'collector') {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function lockKey(lane) {
  const hash = crypto.createHash('sha256').update(`gbrain-collector:${lane}`).digest();
  return hash.readInt32BE(0);
}

function loadJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

class CollectorState {
  constructor(options = {}) {
    this.enabled = options.enabled ?? enabledFromEnv();
    this.databaseUrl = options.databaseUrl || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '';
    this.table = options.table || process.env.GBRAIN_COLLECTOR_STATE_TABLE || 'collector_state';
    this.sql = null;
    this.schemaReady = false;
  }

  async connect() {
    if (!this.enabled) return null;
    if (!this.databaseUrl) throw new Error('GBRAIN collector state requires GBRAIN_DATABASE_URL or DATABASE_URL');
    if (!this.sql) {
      const postgres = loadPostgres();
      this.sql = postgres(this.databaseUrl, {
        max: 2,
        idle_timeout: 5,
        connect_timeout: 10,
        prepare: false,
        onnotice: () => {},
      });
    }
    return this.sql;
  }

  async ensureSchema() {
    if (!this.enabled || this.schemaReady) return;
    const sql = await this.connect();
    await sql`
      create table if not exists collector_state (
        lane text not null,
        key text not null,
        payload jsonb not null,
        updated_at timestamptz not null default now(),
        run_id text,
        primary key (lane, key)
      )
    `;
    this.schemaReady = true;
  }

  async getState(lane, key, fallback = null) {
    if (!this.enabled) return fallback;
    await this.ensureSchema();
    const sql = await this.connect();
    const rows = await sql`
      select payload
      from collector_state
      where lane = ${lane} and key = ${key}
      limit 1
    `;
    return rows[0]?.payload ?? fallback;
  }

  async putState(lane, key, payload, runId = null) {
    if (!this.enabled) return false;
    await this.ensureSchema();
    const sql = await this.connect();
    await sql`
      insert into collector_state (lane, key, payload, run_id)
      values (${lane}, ${key}, ${sql.json(payload)}, ${runId})
      on conflict (lane, key)
      do update set payload = excluded.payload, run_id = excluded.run_id, updated_at = now()
    `;
    return true;
  }

  async withLaneLock(lane, ttlSeconds, fn) {
    if (!this.enabled) return fn(false);
    await this.ensureSchema();
    const sql = await this.connect();
    const key = lockKey(lane);
    const locked = await sql`select pg_try_advisory_lock(${key}) as locked`;
    if (!locked[0]?.locked) return { ok: false, skipped: true, reason: 'collector lane already locked' };
    const timer = setTimeout(() => {}, Math.max(1, Number(ttlSeconds) || 1) * 1000);
    try {
      return await fn(true);
    } finally {
      clearTimeout(timer);
      await sql`select pg_advisory_unlock(${key})`;
    }
  }

  async close() {
    if (this.sql) await this.sql.end({ timeout: 5 });
  }
}

module.exports = {
  CollectorState,
  enabledFromEnv,
  loadJsonFile,
  makeRunId,
  saveJsonFile,
};
