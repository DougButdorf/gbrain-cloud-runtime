#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  CollectorState,
  enabledFromEnv: collectorStateEnabledFromEnv,
  makeRunId,
  saveJsonFile,
} = require('./lib/collector-state');

const WORKSPACE = process.env.GBRAIN_WORKSPACE || '/Users/landokeynes/.openclaw/workspace';
const STATE_DIR = process.env.GBRAIN_GMAIL_FORWARD_STATE_DIR || process.env.GBRAIN_COLLECTOR_STATE_DIR || '/Users/landokeynes/gbrain-phase7/runtime-controlled/state';
const OUT_ROOT = process.env.GBRAIN_GMAIL_FORWARD_OUT_ROOT || process.env.GBRAIN_COLLECTOR_OUT_ROOT || '/Users/landokeynes/gbrain-phase7/runtime-controlled/gmail-forward';
const GWS = process.env.GBRAIN_GWS_COMMAND || path.join(WORKSPACE, 'bin/gws-account');
const GWS_HOME = process.env.GBRAIN_GWS_HOME || process.env.GWS_HOME || process.env.HOME || '/Users/landokeynes';
const SHADOW = process.env.GBRAIN_COLLECTOR_SHADOW === '1';
const MAX_PER_ACCOUNT = Number(process.env.GBRAIN_GMAIL_FORWARD_MAX || '25');
const MAX_BODY_CHARS = Number(process.env.GBRAIN_FULL_EMAIL_MAX_BODY_CHARS || '12000');
const COLLECTOR_STATE_ENABLED = collectorStateEnabledFromEnv();
const LANE = process.env.GBRAIN_GMAIL_FORWARD_COLLECTOR_STATE_LANE || 'gmail_forward';
const HISTORY_IDS_KEY = process.env.GBRAIN_GMAIL_FORWARD_COLLECTOR_STATE_KEY || 'history_ids';
const DEFAULT_ACCOUNTS = [['doug@outbranch.net','doug-outbranch'],['lando@outbranch.net','lando-outbranch'],['doug@boostpricing.com','doug-boostpricing'],['dbutdorf@gmail.com','dbutdorf']];

function selectedAccounts() {
  const raw = process.env.GBRAIN_GMAIL_FORWARD_ACCOUNTS || '';
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return DEFAULT_ACCOUNTS;
  const byEmail = new Map(DEFAULT_ACCOUNTS.map((pair) => [pair[0], pair]));
  const bySlug = new Map(DEFAULT_ACCOUNTS.map((pair) => [pair[1], pair]));
  const selected = [];
  const unknown = [];
  for (const item of wanted) {
    const pair = byEmail.get(item) || bySlug.get(item);
    if (pair) selected.push(pair);
    else unknown.push(item);
  }
  if (unknown.length) throw new Error(`Unknown GBRAIN_GMAIL_FORWARD_ACCOUNTS entries: ${unknown.join(', ')}`);
  return selected;
}

const accounts = selectedAccounts();

function runGws(account, serviceArgs, params) {
  return JSON.parse(execFileSync(GWS, [account, 'gmail'].concat(serviceArgs, ['--params', JSON.stringify(params), '--format', 'json']), { cwd: WORKSPACE, env: Object.assign({}, process.env, { HOME: GWS_HOME }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function header(headers, name) { const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ''; }
function decodeBase64Url(s) { return s ? Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : ''; }
function stripHtml(s) { return String(s || '').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{2,}/g,' ').trim(); }
function collectParts(part, acc) { acc = acc || { text: [], html: [], attachments: [] }; if (!part) return acc; const mime = part.mimeType || ''; if (part.filename) acc.attachments.push(part.filename); const data = part.body && part.body.data; if (data && mime === 'text/plain') acc.text.push(decodeBase64Url(data)); if (data && mime === 'text/html') acc.html.push(stripHtml(decodeBase64Url(data))); for (const child of part.parts || []) collectParts(child, acc); return acc; }
function slugPart(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,72) || 'untitled'; }
function yamlString(s) { return JSON.stringify(String(s || '')); }
function inferContext(text) { const s = String(text || '').toLowerCase(); if (s.includes('advanced virology') || s.includes('advancedvirology') || s.includes('vmrd') || s.includes('gilded') || s.includes('gi vax') || s.includes('microbiologics')) return 'context:advanced-virology'; if (s.includes('boostpricing') || s.includes('boost pricing') || s.includes('vistage')) return 'context:boost-pricing'; if (s.includes('stackbroker') || s.includes('agentincent') || s.includes('bountymesh') || s.includes('outbranch')) return 'context:outbranch-network'; if (s.includes('amtrak') || s.includes('airbnb') || s.includes('hotel') || s.includes('avis') || s.includes('flight') || s.includes('restaurant')) return 'context:personal'; return 'context:outbranch-network'; }
function statePath(slug) { return path.join(STATE_DIR, slug + '.gmail.forward.historyId'); }

function historyIdFromState(state, slug) {
  const raw = state && state.historyIds && state.historyIds[slug];
  return raw == null ? '' : String(raw).trim();
}

function readFileHistoryId(slug) {
  const sp = statePath(slug);
  return fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8').trim() : '';
}

function writeMessage(outDir, account, msg) {
  const headers = msg.payload && msg.payload.headers || [];
  const subject = header(headers, 'Subject') || '(no subject)';
  const from = header(headers, 'From'), to = header(headers, 'To'), cc = header(headers, 'Cc'), date = header(headers, 'Date');
  const labels = msg.labelIds || [];
  const parts = collectParts(msg.payload);
  const bodyRaw = (parts.text.join('\n\n').trim() || parts.html.join('\n\n').trim() || '').trim();
  const body = bodyRaw.length > MAX_BODY_CHARS ? bodyRaw.slice(0, MAX_BODY_CHARS) + '\n\n[Truncated at ' + MAX_BODY_CHARS + ' characters for forward Gmail sync.]' : bodyRaw;
  const contextTag = inferContext(account + ' ' + subject + ' ' + from + ' ' + to + ' ' + cc + ' ' + body.slice(0, 2000));
  const filePath = path.join(outDir, 'emails', String(msg.internalDate || Date.now()) + '-' + slugPart(subject) + '-' + msg.id + '.md');
  const content = '---\ntype: note\ntitle: ' + yamlString('Gmail forward checkpoint: ' + subject) + '\ntags: [' + contextTag + ', source:gmail-forward]\nsource: gmail-forward\nsource_account: ' + yamlString(account) + '\ngmail_message_id: ' + yamlString(msg.id) + '\ngmail_thread_id: ' + yamlString(msg.threadId) + '\nlabels: ' + JSON.stringify(labels) + '\nhas_attachments: ' + (parts.attachments.length > 0 ? 'true' : 'false') + '\n---\n\nGmail forward-only checkpoint for "' + subject + '" from ' + (from || 'unknown sender') + ' to ' + (to || account) + '. Attachment contents are not included.\n\nMetadata: Date: ' + (date || new Date(Number(msg.internalDate || Date.now())).toISOString()) + '. From: ' + (from || 'unknown') + '. To: ' + (to || 'unknown') + '.' + (cc ? ' Cc: ' + cc + '.' : '') + ' Labels: ' + (labels.join(', ') || 'none') + '. Attachments: ' + (parts.attachments.join(', ') || 'none') + '.\n\n---\n\n' + (body || '(No readable body extracted.)') + '\n';
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const importDir = path.join(OUT_ROOT, 'batch-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.join(importDir, 'emails'), { recursive: true });
  const collectorState = new CollectorState();
  const runId = makeRunId('gmail-forward');
  let durableHistoryState = null;
  if (COLLECTOR_STATE_ENABLED) {
    durableHistoryState = await collectorState.getState(LANE, HISTORY_IDS_KEY, null);
  }
  const result = {
    importDir,
    shadow: SHADOW,
    collectorStateEnabled: COLLECTOR_STATE_ENABLED,
    collectorStateSource: durableHistoryState ? 'postgres' : 'file',
    collectorStateLane: COLLECTOR_STATE_ENABLED ? LANE : '',
    baselineOnly: [],
    accounts: [],
    accountErrors: [],
    skippedMessages: [],
    files: [],
  };
  const pendingHistoryIds = durableHistoryState && durableHistoryState.historyIds ? Object.assign({}, durableHistoryState.historyIds) : {};
  for (const pair of accounts) {
    const account = pair[0], slug = pair[1], sp = statePath(pair[1]);
    let profile;
    try {
      profile = runGws(account, ['users','getProfile'], { userId: 'me' });
    } catch (err) {
      result.accountErrors.push({ account, error: String(err && err.message || err).split('\n')[0] });
      continue;
    }
    const existingHistoryId = COLLECTOR_STATE_ENABLED ? historyIdFromState(durableHistoryState, slug) : readFileHistoryId(slug);
    if (!existingHistoryId) {
      pendingHistoryIds[slug] = String(profile.historyId);
      if (!COLLECTOR_STATE_ENABLED && !SHADOW) fs.writeFileSync(sp, String(profile.historyId), { mode: 0o600 });
      result.baselineOnly.push({
        account,
        slug,
        historyId: profile.historyId,
        stateWritten: !COLLECTOR_STATE_ENABLED && !SHADOW,
        pendingCollectorState: COLLECTOR_STATE_ENABLED && !SHADOW,
      });
      continue;
    }
    const startHistoryId = existingHistoryId;
    let pageToken = '', latestHistoryId = profile.historyId;
    const messageIds = [];
    do {
      const params = Object.assign({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], maxResults: 100 }, pageToken ? { pageToken } : {});
      let history;
      try {
        history = runGws(account, ['users','history','list'], params);
      } catch (err) {
        result.accountErrors.push({ account, error: String(err && err.message || err).split('\n')[0] });
        pageToken = '';
        continue;
      }
      latestHistoryId = history.historyId || latestHistoryId;
      for (const h of history.history || []) for (const item of h.messagesAdded || []) if (item.message && item.message.id) messageIds.push(item.message.id);
      pageToken = history.nextPageToken || '';
    } while (pageToken && messageIds.length < MAX_PER_ACCOUNT);
    const files = [];
    for (const id of Array.from(new Set(messageIds)).slice(0, MAX_PER_ACCOUNT)) {
      let msg;
      try {
        msg = runGws(account, ['users','messages','get'], { userId: 'me', id, format: 'full', metadataHeaders: ['From','To','Cc','Subject','Date'] });
      } catch (err) {
        result.skippedMessages.push({ account, messageId: id, reason: 'message-get-failed', error: String(err && err.message || err).split('\n')[0] });
        continue;
      }
      const labels = msg.labelIds || [];
      if (labels.includes('TRASH') || labels.includes('SPAM')) continue;
      files.push(writeMessage(importDir, account, msg));
    }
    result.accounts.push({ account, startHistoryId, latestHistoryId, seen: messageIds.length, written: files.length });
    result.files.push.apply(result.files, files);
    if (!SHADOW) {
      if (COLLECTOR_STATE_ENABLED) {
        pendingHistoryIds[slug] = String(latestHistoryId);
      } else {
        fs.writeFileSync(sp + '.pending', String(latestHistoryId), { mode: 0o600 });
      }
    }
  }
  if (COLLECTOR_STATE_ENABLED && !SHADOW) {
    const pendingFile = path.join(importDir, 'GMAIL_FORWARD_COLLECTOR_STATE_PENDING.json');
    const pending = { lane: LANE, key: HISTORY_IDS_KEY, payload: { historyIds: pendingHistoryIds }, runId };
    saveJsonFile(pendingFile, pending);
    result.collectorStatePendingFile = pendingFile;
  }
  fs.writeFileSync(path.join(importDir, 'GMAIL_FORWARD_BATCH.md'), '# Gmail Forward-Only Batch\n\n' + JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  await collectorState.close();
}
main().catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
