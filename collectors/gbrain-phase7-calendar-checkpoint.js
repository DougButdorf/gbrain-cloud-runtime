#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

const account = process.argv[2] || 'doug@outbranch.net';
const max = Number(process.argv[3] || '5');
const outDir = process.argv[4] || `/Users/landokeynes/gbrain-phase7/calendar-${account.replace(/[^a-z0-9]+/gi, '-')}-checkpoint`;
const days = Number(process.env.GBRAIN_CALENDAR_CHECKPOINT_DAYS || '7');
const workspace = process.env.GBRAIN_WORKSPACE || '/Users/landokeynes/.openclaw/workspace';
const gws = process.env.GBRAIN_GWS_COMMAND || join(workspace, 'bin/gws-account');
const gwsHome = process.env.GBRAIN_GWS_HOME || process.env.GWS_HOME || process.env.HOME || '/Users/landokeynes';

function runGws(args) {
  const out = execFileSync(gws, args, {
    cwd: workspace,
    env: { ...process.env, HOME: gwsHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function yamlString(s) {
  return JSON.stringify(String(s || ''));
}

function slugPart(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'untitled';
}

function iso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function inferContext(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('advanced virology') || s.includes('advancedvirology') || s.includes('vmrd') || s.includes('gilded') || s.includes('gi vax') || s.includes('cdi')) {
    return 'context:advanced-virology';
  }
  if (s.includes('boostpricing') || s.includes('boost pricing') || s.includes('vistage') || s.includes('casey brown') || s.includes('automated logistics')) {
    return 'context:boost-pricing';
  }
  if (s.includes('nocap') || s.includes('ncaa')) return 'context:nocap-sports';
  if (s.includes('palm bay') || s.includes('rentacar') || s.includes('car rental') || s.includes('villa') || s.includes('amtrak') || s.includes('airbnb') || s.includes('hotel') || s.includes('avis') || s.includes('flight') || s.includes('dinner') || s.includes('trash')) {
    return 'context:personal';
  }
  return 'context:outbranch-network';
}

const now = new Date();
const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'meetings'), { recursive: true });

const events = runGws([
  account,
  'calendar', 'events', 'list',
  '--params', JSON.stringify({
    calendarId: 'primary',
    timeMin: iso(now),
    timeMax: iso(end),
    maxResults: max,
    singleEvents: true,
    orderBy: 'startTime',
  }),
  '--format', 'json',
]);

const items = events.items || [];
const written = [];

for (const ev of items) {
  const title = ev.summary || '(no title)';
  const start = ev.start?.dateTime || ev.start?.date || '';
  const endTime = ev.end?.dateTime || ev.end?.date || '';
  const organizer = ev.organizer?.email || ev.creator?.email || '';
  const attendeeCount = Array.isArray(ev.attendees) ? ev.attendees.length : 0;
  const location = ev.location || '';
  const status = ev.status || '';
  const attendeeText = Array.isArray(ev.attendees) ? ev.attendees.map((a) => `${a.email || ''} ${a.displayName || ''}`).join(' ') : '';
  const contextTag = inferContext(`${account} ${title} ${organizer} ${attendeeText} ${location}`);
  const filename = `${start || ev.created || Date.now()}-${slugPart(title)}-${slugPart(ev.id)}.md`.replace(/[:]/g, '-');
  const path = join(outDir, 'meetings', filename);
  const content = `---\n` +
    `type: meeting\n` +
    `title: ${yamlString(`Calendar checkpoint: ${title}`)}\n` +
    `tags: [${contextTag}]\n` +
    `source: google-calendar\n` +
    `source_account: ${yamlString(account)}\n` +
    `calendar_event_id: ${yamlString(ev.id)}\n` +
    `status: ${yamlString(status)}\n` +
    `---\n\n` +
    `Calendar checkpoint metadata for "${title}" from ${start || 'unknown start'} to ${endTime || 'unknown end'}. This Phase 7 checkpoint intentionally excludes descriptions, meeting links, passcodes, attachments, and conference dial-in data.\n\n` +
    `---\n\n` +
    `- ${start || iso(now)}: Calendar metadata checkpoint. Organizer: ${organizer || 'unknown'}. Attendees: ${attendeeCount}. Location label: ${location || 'none'}. Status: ${status || 'unknown'}.\n`;
  writeFileSync(path, content, { mode: 0o600 });
  written.push(path);
}

writeFileSync(join(outDir, 'PHASE7_CALENDAR_CHECKPOINT.md'), `# Phase 7 Calendar Checkpoint\n\nAccount: ${account}\n\nScope: next ${items.length} primary-calendar events over ${days} days. Metadata only. Descriptions, meeting links, passcodes, attachments, and conference dial-in data are intentionally excluded.\n\nFiles:\n${written.map((p) => `- ${p}`).join('\n')}\n`, { mode: 0o600 });

console.log(JSON.stringify({ account, outDir, count: written.length, days, files: written }, null, 2));
