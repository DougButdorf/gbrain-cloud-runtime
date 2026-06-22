#!/usr/bin/env node
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { tmpdir } = require('os');

const HOME = process.env.GBRAIN_COLLECTOR_HOME || process.env.HOME || '/Users/landokeynes';
const workspace = process.env.GBRAIN_WORKSPACE || '/Users/landokeynes/.openclaw/workspace';
const envFile = process.env.AV_M365_ENV_FILE || join(workspace, 'advanced-virology-crm/.env.local');
const tokenFile = process.env.AV_M365_GRAPH_TOKEN_FILE || join(workspace, 'secrets/av-m365-graph-token.json');
const mailbox = process.argv[2] || 'doug@advancedvirology.com';
const max = Number(process.argv[3] || process.env.GBRAIN_PHASE7_AV_M365_MAX || '150');
const outDir = process.argv[4] || process.env.GBRAIN_PHASE7_AV_M365_OUT_DIR || join(HOME, 'gbrain-phase7/runtime-controlled/av-m365-graph-rolling');
const skip = Number(process.argv[5] || process.env.GBRAIN_PHASE7_AV_M365_SKIP || '0');
const maxBodyChars = Number(process.env.GBRAIN_FULL_EMAIL_MAX_BODY_CHARS || '12000');
const since = process.env.GBRAIN_PHASE7_AV_M365_SINCE || '';
const stateRoot = process.env.GBRAIN_PHASE7_STATE_ROOT || join(HOME, 'gbrain-phase7/runtime-controlled/state');
const attachmentStateFile = process.env.GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE || join(workspace, 'ops/data/gbrain-av-m365-attachment-sha256.json');
const messageStateFile = process.env.GBRAIN_PHASE7_AV_M365_MESSAGE_STATE_FILE || join(workspace, 'ops/data/gbrain-av-m365-message-ids.json');
const deferMessageState = process.env.GBRAIN_DEFER_MESSAGE_STATE === '1';
const shadow = process.env.GBRAIN_COLLECTOR_SHADOW === '1' || process.env.GBRAIN_STATE_READ_ONLY === '1';
const extractor = process.env.GBRAIN_READABLE_ATTACHMENT_EXTRACTOR || join(workspace, 'ops/lib/readable_attachment_extract.py');

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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

function emailAddress(recipient) {
  const e = recipient?.emailAddress;
  if (!e) return '';
  const name = e.name || '';
  const addr = e.address || '';
  return name && addr && name.toLowerCase() !== addr.toLowerCase() ? `${name} <${addr}>` : addr || name;
}

function listAddresses(recipients) {
  return (recipients || []).map(emailAddress).filter(Boolean).join(', ');
}

function capBody(s) {
  const body = String(s || '').trim();
  if (body.length <= maxBodyChars) return body;
  return `${body.slice(0, maxBodyChars)}\n\n[Truncated at ${maxBodyChars} characters for Phase 7 batch control.]`;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeFilename(s) {
  return String(s || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'attachment';
}

function extractReadableAttachment(buffer, filename) {
  const tmp = mkdtempSync(join(tmpdir(), 'gbrain-av-attachment-'));
  const file = join(tmp, safeFilename(filename));
  try {
    writeFileSync(file, buffer, { mode: 0o600 });
    const out = execFileSync('python3', [extractor, file], {
      cwd: workspace,
      env: { ...process.env, HOME },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 240000,
    });
    return JSON.parse(out);
  } catch (error) {
    return { ok: false, text: '', method: 'extractor-error', reason: String(error && error.message || error).split('\n')[0] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeAttachmentPage(outDir, mailbox, msg, att, hash, extraction) {
  const subject = msg.subject || '(no subject)';
  const occurred = msg.receivedDateTime || msg.sentDateTime || new Date().toISOString();
  const attachmentDir = join(outDir, 'attachments');
  mkdirSync(attachmentDir, { recursive: true });
  const filename = `${String(occurred).replace(/[:.]/g, '-')}-${slugPart(subject)}-${hash.slice(0, 16)}-${slugPart(att.name || 'attachment')}.md`;
  const pagePath = join(attachmentDir, filename);
  const content = `---\n` +
    `type: note\n` +
    `title: ${yamlString(`AV M365 PDF attachment: ${att.name || 'attachment'}`)}\n` +
    `tags: [context:advanced-virology, source:outlook-m365, source:email-attachment, attachment:pdf]\n` +
    `source: outlook-m365-attachment\n` +
    `source_account: ${yamlString(mailbox)}\n` +
    `outlook_message_id: ${yamlString(msg.id)}\n` +
    `outlook_conversation_id: ${yamlString(msg.conversationId || '')}\n` +
    `attachment_filename: ${yamlString(att.name || '')}\n` +
    `attachment_mime_type: ${yamlString(att.contentType || '')}\n` +
    `attachment_sha256: ${yamlString(hash)}\n` +
    `extraction_method: ${yamlString(extraction.method || '')}\n` +
    `receivedDateTime: ${yamlString(msg.receivedDateTime || '')}\n` +
    `---\n\n` +
    `Readable PDF attachment text extracted from Advanced Virology Outlook email "${subject}".\n\n` +
    `Source message: ${msg.webLink || 'none'}\n\n` +
    `Attachment: ${att.name || 'attachment'} (${att.contentType || 'application/pdf'}). SHA-256: ${hash}.\n\n` +
    `---\n\n` +
    `${extraction.text || '(No readable text extracted.)'}\n`;
  writeFileSync(pagePath, content, { mode: 0o600 });
  return pagePath;
}

async function refreshTokenIfNeeded(token) {
  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() > 5 * 60 * 1000) return token;

  const tenantId = process.env.M365_TENANT_ID;
  const clientId = token.client_id || process.env.M365_CLIENT_ID;
  const clientSecret = process.env.M365_CLIENT_SECRET;
  const scope = 'offline_access User.Read Mail.Read Calendars.Read';

  async function attempt(includeSecret) {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      scope,
    });
    if (includeSecret && clientSecret) body.set('client_secret', clientSecret);
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  let { res, json } = await attempt(false);
  if (!res.ok && clientSecret) ({ res, json } = await attempt(true));
  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    throw new Error(`M365 refresh failed: ${detail}`);
  }

  const next = {
    ...token,
    scopes: json.scope || token.scopes,
    token_type: json.token_type || token.token_type || 'Bearer',
    expires_at: new Date(Date.now() + Number(json.expires_in || 3600) * 1000).toISOString(),
    access_token: json.access_token,
    refresh_token: json.refresh_token || token.refresh_token,
    refreshed_at: new Date().toISOString(),
  };
  if (!shadow) writeFileSync(tokenFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function getClientCredentialsToken() {
  const tenantId = process.env.M365_TENANT_ID;
  const clientId = process.env.M365_CLIENT_ID;
  const clientSecret = process.env.M365_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('M365 credentials missing: need delegated token file or M365_TENANT_ID/M365_CLIENT_ID/M365_CLIENT_SECRET');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    throw new Error(`M365 client credentials auth failed: ${detail}`);
  }

  return {
    token_type: json.token_type || 'Bearer',
    access_token: json.access_token,
    expires_at: new Date(Date.now() + Number(json.expires_in || 3600) * 1000).toISOString(),
  };
}

async function graphGet(path, token, query) {
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error?.message || json.error_description || res.statusText;
    throw new Error(`Graph request failed: ${detail}`);
  }
  return json;
}

async function graphGetAbsolute(urlString, token) {
  const res = await fetch(urlString, {
    headers: { Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error?.message || json.error_description || res.statusText;
    throw new Error(`Graph request failed: ${detail}`);
  }
  return json;
}

async function listMessages(token, seenMessages = {}) {
  if (!since) {
    const result = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages`, token, {
      '$top': Math.min(max, 999),
      '$skip': skip,
      '$orderby': 'receivedDateTime desc',
      '$select': 'id,conversationId,subject,body,bodyPreview,webLink,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,internetMessageId,importance,hasAttachments,isRead',
    });
    return result.value || [];
  }

  const messages = [];
  let result = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages`, token, {
    '$top': Math.min(max, 100),
    '$orderby': 'receivedDateTime desc',
    '$filter': `receivedDateTime ge ${since}`,
    '$select': 'id,conversationId,subject,body,bodyPreview,webLink,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,internetMessageId,importance,hasAttachments,isRead',
  });
  while (result) {
    for (const msg of result.value || []) {
      if (seenMessages[msg.id]) continue;
      messages.push(msg);
      if (messages.length >= max) return messages;
    }
    const next = result['@odata.nextLink'];
    result = next ? await graphGetAbsolute(next, token) : null;
  }
  return messages;
}

async function processPdfAttachments(token, outDir, mailbox, msg, seenHashes) {
  if (!msg.hasAttachments) return [];
  const result = await graphGet(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msg.id)}/attachments`, token, {
    '$top': 999,
  });
  const written = [];
  for (const att of result.value || []) {
    if (att['@odata.type'] && att['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
    const name = att.name || '';
    const mime = String(att.contentType || '').toLowerCase();
    if (!name.toLowerCase().endsWith('.pdf') && mime !== 'application/pdf') continue;
    if (!att.contentBytes) continue;
    const buffer = Buffer.from(att.contentBytes, 'base64');
    const hash = sha256(buffer);
    if (seenHashes[hash]) continue;
    const extraction = extractReadableAttachment(buffer, name || `${hash}.pdf`);
    seenHashes[hash] = {
      filename: name,
      messageId: msg.id,
      receivedDateTime: msg.receivedDateTime || '',
      method: extraction.method || '',
      ok: Boolean(extraction.ok),
      recordedAt: new Date().toISOString(),
    };
    if (!extraction.ok) continue;
    written.push(writeAttachmentPage(outDir, mailbox, msg, att, hash, extraction));
  }
  return written;
}

async function main() {
  loadEnv(envFile);
  let token;
  try {
    token = JSON.parse(readFileSync(tokenFile, 'utf8'));
    token = await refreshTokenIfNeeded(token);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = await getClientCredentialsToken();
  }

  mkdirSync(join(outDir, 'emails'), { recursive: true });

  const messageState = since ? loadJson(messageStateFile, {}) : {};
  const messages = await listMessages(token, messageState);
  const written = [];
  const attachmentHashes = loadJson(attachmentStateFile, {});
  const processedMessages = {};

  for (const msg of messages) {
    const subject = msg.subject || '(no subject)';
    const bodyText = msg.body?.contentType?.toLowerCase() === 'html' ? stripHtml(msg.body?.content) : String(msg.body?.content || '').trim();
    const from = emailAddress(msg.from || msg.sender) || 'unknown';
    const to = listAddresses(msg.toRecipients);
    const cc = listAddresses(msg.ccRecipients);
    const bcc = listAddresses(msg.bccRecipients);
    const occurred = msg.receivedDateTime || msg.sentDateTime || new Date().toISOString();
    const filename = `${String(occurred).replace(/[:.]/g, '-')}-${slugPart(subject)}-${slugPart(msg.id).slice(0, 24)}.md`;
    const path = join(outDir, 'emails', filename);
    const content = `---\n` +
      `type: note\n` +
      `title: ${yamlString(`M365 Outlook full checkpoint: ${subject}`)}\n` +
      `tags: [context:advanced-virology]\n` +
      `source: outlook-m365\n` +
      `source_account: ${yamlString(mailbox)}\n` +
      `outlook_message_id: ${yamlString(msg.id)}\n` +
      `outlook_conversation_id: ${yamlString(msg.conversationId || '')}\n` +
      `internet_message_id: ${yamlString(msg.internetMessageId || '')}\n` +
      `receivedDateTime: ${yamlString(msg.receivedDateTime || '')}\n` +
      `has_attachments: ${msg.hasAttachments ? 'true' : 'false'}\n` +
      `---\n\n` +
      `M365 Outlook full-body checkpoint for "${subject}" from ${from} to ${to || mailbox}. Attachment contents are not included.\n\n` +
      `Metadata: Received: ${msg.receivedDateTime || 'unknown'}. Sent: ${msg.sentDateTime || 'unknown'}. From: ${from}. To: ${to || 'unknown'}.${cc ? ` Cc: ${cc}.` : ''}${bcc ? ` Bcc: ${bcc}.` : ''} Importance: ${msg.importance || 'normal'}. Web link: ${msg.webLink || 'none'}. Attachments present: ${msg.hasAttachments ? 'yes' : 'no'}.\n\n` +
      `---\n\n` +
      `${capBody(bodyText || msg.bodyPreview || '(No readable body extracted.)')}\n`;
    writeFileSync(path, content, { mode: 0o600 });
    written.push(path);
    const attachmentFiles = await processPdfAttachments(token, outDir, mailbox, msg, attachmentHashes);
    written.push(...attachmentFiles);
    if (since) {
      const entry = {
        receivedDateTime: msg.receivedDateTime || '',
        hasAttachments: Boolean(msg.hasAttachments),
        processedAt: new Date().toISOString(),
      };
      messageState[msg.id] = entry;
      processedMessages[msg.id] = entry;
    }
  }
  const attachmentStateWritten = !shadow;
  const messageStateWritten = since && !shadow;
  if (!shadow) saveJson(attachmentStateFile, attachmentHashes);
  if (since) {
    if (shadow) {
      saveJson(join(outDir, 'PHASE7_AV_M365_MESSAGE_STATE_PENDING.json'), processedMessages);
    } else if (deferMessageState) {
      saveJson(join(outDir, 'PHASE7_AV_M365_MESSAGE_STATE_PENDING.json'), processedMessages);
    } else {
      saveJson(messageStateFile, messageState);
    }
  }

  writeFileSync(join(outDir, 'PHASE7_AV_M365_GRAPH_BATCH.md'), `# Phase 7 AV M365 Graph Full-Body Batch\n\nAccount: ${mailbox}\n\nSource: Microsoft Graph delegated OAuth\n\nSkip used: ${skip}\n\nSince used: ${since || 'not set'}\n\nMessages returned: ${messages.length}\n\nScope: Advanced Virology Outlook full-body messages plus readable PDF attachment text only. Other attachment types are intentionally skipped for AV.\n\nFiles:\n${written.map((p) => `- ${p}`).join('\n')}\n`, { mode: 0o600 });

  console.log(JSON.stringify({
    ok: true,
    mailbox,
    outDir,
    count: written.length,
    messageCount: messages.length,
    skip,
    since,
    nextSkip: skip + messages.length,
    shadow,
    stateAdvanced: false,
    attachmentStateWritten,
    messageStateWritten,
    stateRoot,
    files: written,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
