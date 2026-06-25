#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  CollectorState,
  makeRunId,
} = require('./lib/collector-state');

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has('--apply');
const json = args.has('--json');
const pendingPath = argv.find((arg) => !arg.startsWith('--'));
const defaultLane = process.env.GBRAIN_COLLECTOR_LANE || 'av_m365';
const runId = process.env.GBRAIN_COLLECTOR_RUN_ID || makeRunId(`${defaultLane}-apply-pending`);

function countObject(value) {
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function readPending(file) {
  if (!file) {
    throw new Error('Usage: gbrain-av-m365-collector-state-apply-pending.js [--apply] [--json] PENDING_JSON');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const pending = readPending(pendingPath);
  const lane = pending.lane || defaultLane;
  const rows = pending.rows || {};
  const state = new CollectorState({ enabled: true });
  const rowKeys = ['skip', 'attachment_sha256', 'message_ids'].filter((key) => rows[key] !== null && rows[key] !== undefined);

  const readback = {};
  if (apply) {
    for (const key of rowKeys) {
      await state.putState(lane, key, rows[key], runId);
    }
    for (const key of rowKeys) {
      readback[key] = await state.getState(lane, key, null);
    }
  }
  await state.close();

  const output = {
    ok: true,
    applied: apply,
    lane,
    runId,
    pendingPath,
    sourceRunId: pending.runId || null,
    sourceSkip: pending.skip ?? null,
    sourceNextSkip: pending.nextSkip ?? null,
    sourceMessageCount: pending.messageCount ?? null,
    rowKeys,
    counts: {
      attachmentSha256: countObject(rows.attachment_sha256),
      messageIds: countObject(rows.message_ids),
    },
    readback: apply ? {
      skip: readback.skip?.value ?? null,
      attachmentSha256: countObject(readback.attachment_sha256),
      messageIds: countObject(readback.message_ids),
    } : null,
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`AV_M365_COLLECTOR_STATE_PENDING ${apply ? 'APPLIED' : 'DRY_RUN'} lane=${lane} next_skip=${output.sourceNextSkip} attachment_sha256=${output.counts.attachmentSha256} message_ids=${output.counts.messageIds}`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
