#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CollectorState,
  makeRunId,
} = require('./lib/collector-state');

const STATE_DIR = process.env.GBRAIN_GMAIL_FORWARD_STATE_DIR || process.env.GBRAIN_COLLECTOR_STATE_DIR || '/Users/landokeynes/gbrain-phase7/runtime-controlled/state';
const LANE = process.env.GBRAIN_GMAIL_FORWARD_COLLECTOR_STATE_LANE || 'gmail_forward';
const KEY = process.env.GBRAIN_GMAIL_FORWARD_COLLECTOR_STATE_KEY || 'history_ids';
const ACCOUNTS = [
  ['doug@outbranch.net', 'doug-outbranch'],
  ['lando@outbranch.net', 'lando-outbranch'],
  ['doug@boostpricing.com', 'doug-boostpricing'],
  ['dbutdorf@gmail.com', 'dbutdorf'],
];

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

function readHistoryIds() {
  const historyIds = {};
  const missing = [];
  for (const [account, slug] of ACCOUNTS) {
    const file = path.join(STATE_DIR, `${slug}.gmail.forward.historyId`);
    if (!fs.existsSync(file)) {
      missing.push({ account, slug, file });
      continue;
    }
    historyIds[slug] = fs.readFileSync(file, 'utf8').trim();
  }
  return { historyIds, missing };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { historyIds, missing } = readHistoryIds();
  const state = new CollectorState({ enabled: args.apply });
  const payload = { historyIds };
  let readback = null;

  if (args.apply) {
    await state.putState(LANE, KEY, payload, makeRunId('gmail-forward-seed'));
    readback = await state.getState(LANE, KEY, null);
  }

  const result = {
    ok: true,
    applied: args.apply,
    lane: LANE,
    key: KEY,
    stateDir: STATE_DIR,
    accountCount: ACCOUNTS.length,
    historyIds,
    missing,
    readback,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`GMAIL_FORWARD_COLLECTOR_STATE_SEED_OK applied=${args.apply ? '1' : '0'} accounts=${Object.keys(historyIds).length} missing=${missing.length}`);
  }
  await state.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
