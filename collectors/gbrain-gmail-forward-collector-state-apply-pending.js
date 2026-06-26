#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  CollectorState,
} = require('./lib/collector-state');

function parseArgs(argv) {
  const args = { apply: false, json: false, file: '' };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (!args.file) args.file = arg;
  }
  if (!args.file) throw new Error('Usage: gbrain-gmail-forward-collector-state-apply-pending.js [--apply] [--json] PENDING_JSON');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pending = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  if (!pending.lane || !pending.key || !pending.payload) {
    throw new Error('Pending Gmail collector state file must include lane, key, and payload');
  }

  const state = new CollectorState({ enabled: args.apply });
  let readback = null;
  if (args.apply) {
    await state.putState(pending.lane, pending.key, pending.payload, pending.runId || null);
    readback = await state.getState(pending.lane, pending.key, null);
  }

  const result = {
    ok: true,
    applied: args.apply,
    lane: pending.lane,
    key: pending.key,
    historyIdCount: Object.keys(pending.payload.historyIds || {}).length,
    readback,
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`GMAIL_FORWARD_COLLECTOR_STATE_APPLY_OK applied=${args.apply ? '1' : '0'} history_ids=${result.historyIdCount}`);
  await state.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
