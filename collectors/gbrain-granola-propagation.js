#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
let postgres;
try {
  postgres = require('postgres');
} catch {
  postgres = require(process.env.GBRAIN_POSTGRES_MODULE || '/Users/landokeynes/gbrain/node_modules/postgres');
}

const DEFAULT_CONFIG = process.env.GBRAIN_CONFIG_PATH || '/Users/landokeynes/.gbrain/config.json';
const LOCK_KEY = 73170508;
const BATCH_SIZE = 500;
const DEFAULT_LIMIT = 200;

const argv = process.argv.slice(2);
const args = new Set(argv);
const shadow = process.env.GBRAIN_COLLECTOR_SHADOW === '1' || args.has('--shadow');
const apply = args.has('--apply') && !shadow;
const json = args.has('--json');
const verbose = args.has('--verbose');
const includeOwner = args.has('--include-owner');

function readFlag(name, fallback) {
  const prefix = `${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length);
}

const configPath = readFlag('--config', DEFAULT_CONFIG);
const limit = Number(readFlag('--limit', process.env.GBRAIN_GRANOLA_PROPAGATION_LIMIT || String(DEFAULT_LIMIT))) || 0;
const maxNewLinks = Number(readFlag('--max-new-links', process.env.GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS || '0')) || 0;
const maxNewTimelines = Number(readFlag('--max-new-timelines', process.env.GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES || '0')) || 0;
const excludedSlugs = new Set([
  ...(includeOwner ? [] : ['people/doug-butdorf', 'companies/outbranch-network']),
  ...String(readFlag('--exclude-slugs', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

function usage() {
  return [
    'Usage: gbrain-granola-propagation.js [--apply] [--shadow] [--json] [--verbose] [--include-owner] [--limit=N] [--max-new-links=N] [--max-new-timelines=N] [--exclude-slugs=a,b] [--config=/path/config.json]',
    '',
    'Propagates existing Granola meeting pages into typed graph links and entity timelines.',
    `Defaults to dry-run with --limit=${DEFAULT_LIMIT}. Use --limit=0 to scan all Granola meetings.`,
    'Writes links/timeline only with --apply. GBRAIN_COLLECTOR_SHADOW=1 or --shadow forces dry-run.',
  ].join('\n');
}

if (args.has('--help') || args.has('-h')) {
  console.log(usage());
  process.exit(0);
}

function loadConfig(file) {
  const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '';
  if (databaseUrl) return { database_url: databaseUrl, source: 'env' };
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.database_url) throw new Error(`Missing database_url in ${file}`);
  return { ...cfg, source: file };
}

function stableHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function normalizeAlias(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function textKey(s) {
  return normalizeAlias(s).toLowerCase();
}

function slugKey(s) {
  return textKey(s)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function domainFromEmail(email) {
  const m = String(email || '').toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
  return m ? m[1] : '';
}

function hostname(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceDate(page) {
  const fm = page.frontmatter || {};
  for (const c of [fm.date_iso, fm.meeting_date, fm.date, fm.start, fm.start_time, fm.startTime]) {
    if (!c) continue;
    const m = String(c).match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (m) return m[1];
    const d = new Date(String(c).replace(/\s+(EDT|EST)$/, ''));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function titleSummary(page) {
  return String(page.title || page.slug).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function participantLine(page) {
  const body = String(page.compiled_truth || '');
  const m = body.match(/^- Participants:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

function splitParticipants(line) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of String(line || '')) {
    if (ch === '<') depth += 1;
    if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseParticipant(raw) {
  const emailMatch = raw.match(/<([^<>@\s]+@[^<>\s]+)>|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const email = emailMatch ? (emailMatch[1] || emailMatch[2]).toLowerCase() : '';
  const beforeEmail = emailMatch ? raw.slice(0, emailMatch.index).trim() : raw.trim();
  const fromMatch = beforeEmail.match(/\s+from\s+(.+)$/i);
  const company = fromMatch ? normalizeAlias(fromMatch[1].replace(/\([^)]*\)/g, '')) : '';
  const namePart = (fromMatch ? beforeEmail.slice(0, fromMatch.index) : beforeEmail)
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    raw,
    name: normalizeAlias(namePart),
    email,
    domain: domainFromEmail(email),
    company,
  };
}

function aliasSafety(entity, alias) {
  const a = normalizeAlias(alias);
  if (!a) return { ok: false, reason: 'empty' };
  if (a.includes('@')) return { ok: true, kind: 'email' };
  if (/^https?:\/\//i.test(a) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(a)) return { ok: true, kind: 'domain' };
  if (entity.type === 'person') {
    if (/\s/.test(a) && a.length >= 7) return { ok: true, kind: 'full_name' };
    return { ok: false, reason: 'person_single_token_alias' };
  }
  if (entity.type === 'company') {
    if (a.length >= 6) return { ok: true, kind: 'company_alias' };
    if (/^[A-Z0-9&]{4,}$/.test(a)) return { ok: true, kind: 'company_acronym' };
    return { ok: false, reason: 'company_alias_too_short' };
  }
  return { ok: false, reason: 'unknown_entity_type' };
}

function addUnique(map, key, item, suppressed) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  const existing = map.get(key);
  if (existing.some((mapped) => mapped.source_id === item.source_id && mapped.slug === item.slug)) return;
  existing.push(item);
  if (existing.length > 1) {
    for (const mapped of map.get(key)) suppressed.push({ key, slug: mapped.slug, reason: 'key_maps_to_multiple_entities' });
  }
}

function singletonMap(multi) {
  const out = new Map();
  for (const [key, items] of multi.entries()) {
    const uniqueSlugs = new Set(items.map((i) => `${i.source_id}:${i.slug}`));
    if (uniqueSlugs.size === 1) out.set(key, items[0]);
  }
  return out;
}

function buildEntityIndex(rows) {
  const suppressed = [];
  const personByEmailMulti = new Map();
  const personByNameMulti = new Map();
  const companyByNameMulti = new Map();
  const companyByDomainMulti = new Map();

  for (const row of rows) {
    const type = row.type === 'company' || row.slug.startsWith('companies/') ? 'company' : 'person';
    const entity = {
      id: row.id,
      source_id: row.source_id,
      slug: row.slug,
      type,
      title: normalizeAlias(row.title || row.slug),
      frontmatter: row.frontmatter || {},
    };
    const fm = entity.frontmatter;
    const aliases = [entity.title, ...asArray(fm.aliases), ...asArray(fm.email_addresses), ...asArray(fm.emails)];
    if (type === 'person') {
      for (const raw of aliases) {
        const alias = normalizeAlias(raw);
        const safety = aliasSafety(entity, alias);
        if (!safety.ok) {
          suppressed.push({ alias, slug: entity.slug, reason: safety.reason });
          continue;
        }
        if (safety.kind === 'email') addUnique(personByEmailMulti, textKey(alias), { ...entity, matched_alias: alias, evidence: 'email' }, suppressed);
        if (safety.kind === 'full_name') addUnique(personByNameMulti, textKey(alias), { ...entity, matched_alias: alias, evidence: 'full_name' }, suppressed);
      }
    } else {
      const domainAliases = [
        ...asArray(fm.domains),
        ...asArray(fm.domain),
        ...asArray(fm.website),
        ...asArray(fm.url),
      ].map(hostname).filter(Boolean);
      for (const domain of domainAliases) addUnique(companyByDomainMulti, domain, { ...entity, matched_alias: domain, evidence: 'domain' }, suppressed);
      for (const raw of [...aliases, entity.slug.replace(/^companies\//, '').replace(/-/g, ' ')]) {
        const alias = normalizeAlias(raw);
        const safety = aliasSafety(entity, alias);
        if (!safety.ok) {
          suppressed.push({ alias, slug: entity.slug, reason: safety.reason });
          continue;
        }
        if (safety.kind === 'domain') addUnique(companyByDomainMulti, hostname(alias), { ...entity, matched_alias: alias, evidence: 'domain' }, suppressed);
        else addUnique(companyByNameMulti, slugKey(alias), { ...entity, matched_alias: alias, evidence: 'company_name' }, suppressed);
      }
    }
  }

  return {
    personByEmail: singletonMap(personByEmailMulti),
    personByName: singletonMap(personByNameMulti),
    companyByName: singletonMap(companyByNameMulti),
    companyByDomain: singletonMap(companyByDomainMulti),
    suppressed,
  };
}

function matchParticipants(page, index) {
  const line = participantLine(page);
  const participants = splitParticipants(line).map(parseParticipant);
  const matches = [];
  const seen = new Set();

  function add(entity, participant, linkType) {
    if (!entity) return;
    const key = `${entity.source_id}:${entity.slug}:${linkType}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ entity, participant, link_type: linkType });
  }

  for (const p of participants) {
    if (p.email) add(index.personByEmail.get(textKey(p.email)), p, 'attendee');
    if (p.name) add(index.personByName.get(textKey(p.name)), p, 'attendee');
    if (p.company) add(index.companyByName.get(slugKey(p.company)), p, 'attendee_company');
    if (p.domain) add(index.companyByDomain.get(p.domain), p, 'attendee_company');
  }

  return { line, participants, matches };
}

async function fetchRows(sql) {
  const entities = await sql`
    SELECT id, source_id, slug, type, title, frontmatter, deleted_at
    FROM pages
    WHERE deleted_at IS NULL
      AND (type IN ('person', 'company') OR slug LIKE 'people/%' OR slug LIKE 'companies/%')
    ORDER BY slug
  `;

  const pageLimit = limit > 0 ? sql`LIMIT ${limit}` : sql``;
  const meetings = await sql`
    SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, created_at, updated_at, deleted_at
    FROM pages
    WHERE deleted_at IS NULL
      AND page_kind = 'markdown'
      AND type = 'meeting'
      AND (frontmatter->>'source' = 'granola' OR frontmatter ? 'granola_id')
    ORDER BY updated_at DESC
    ${pageLimit}
  `;
  return { entities, meetings };
}

async function existingKeys(sql, links, timelines) {
  const linkKeys = new Set();
  const timelineKeys = new Set();
  if (links.length) {
    const hashes = links.map((l) => l.key);
    const rows = await sql`
      SELECT md5(f.source_id || ':' || f.slug || '>' || t.source_id || ':' || t.slug || ':' || l.link_type || ':' || coalesce(l.link_source, '')) AS key
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE md5(f.source_id || ':' || f.slug || '>' || t.source_id || ':' || t.slug || ':' || l.link_type || ':' || coalesce(l.link_source, '')) = ANY(${hashes}::text[])
    `;
    for (const r of rows) linkKeys.add(r.key);
  }
  if (timelines.length) {
    const hashes = timelines.map((t) => t.key);
    const rows = await sql`
      SELECT md5(p.source_id || ':' || p.slug || ':' || te.date::text || ':' || te.summary) AS key
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id
      WHERE md5(p.source_id || ':' || p.slug || ':' || te.date::text || ':' || te.summary) = ANY(${hashes}::text[])
    `;
    for (const r of rows) timelineKeys.add(r.key);
  }
  return { linkKeys, timelineKeys };
}

async function insertLinks(sql, links) {
  let inserted = 0;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    const rows = await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
      SELECT * FROM unnest(${batch.map((l) => l.from_id)}::int[], ${batch.map((l) => l.to_id)}::int[], ${batch.map((l) => l.link_type)}::text[], ${batch.map((l) => l.context)}::text[])
        AS v(from_page_id, to_page_id, link_type, context),
        LATERAL (SELECT 'manual'::text AS link_source, NULL::int AS origin_page_id, NULL::text AS origin_field) p
      ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
      RETURNING 1
    `;
    inserted += rows.length;
  }
  return inserted;
}

async function insertTimelines(sql, timelines) {
  let inserted = 0;
  for (let i = 0; i < timelines.length; i += BATCH_SIZE) {
    const batch = timelines.slice(i, i + BATCH_SIZE);
    const rows = await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT page_id, date::date, source, summary, detail
      FROM unnest(${batch.map((t) => t.page_id)}::int[], ${batch.map((t) => t.date)}::text[], ${batch.map((t) => t.source)}::text[], ${batch.map((t) => t.summary)}::text[], ${batch.map((t) => t.detail)}::text[])
        AS v(page_id, date, source, summary, detail)
      ON CONFLICT (page_id, date, summary) DO NOTHING
      RETURNING 1
    `;
    inserted += rows.length;
  }
  return inserted;
}

function summarizeBySlug(rows, field) {
  const map = new Map();
  for (const row of rows) map.set(row[field], (map.get(row[field]) || 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([slug, count]) => ({ slug, count }));
}

async function main() {
  const cfg = loadConfig(configPath);
  const sql = postgres(cfg.database_url, {
    max: 1,
    ssl: 'require',
    idle_timeout: 5,
    connect_timeout: 15,
  });

  try {
    const lock = await sql`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!lock[0].locked) {
      const out = { ok: true, skipped: true, reason: 'another gbrain granola propagation is already running' };
      console.log(json ? JSON.stringify(out, null, 2) : 'Skipped: another gbrain granola propagation is already running.');
      return;
    }

    const { entities, meetings } = await fetchRows(sql);
    const filteredEntities = entities.filter((entity) => !excludedSlugs.has(entity.slug));
    const index = buildEntityIndex(filteredEntities);
    const links = [];
    const timelines = [];
    const scanned = [];

    for (const page of meetings) {
      const { participants, matches } = matchParticipants(page, index);
      scanned.push({ slug: page.slug, participants: participants.length, matches: matches.length });
      const date = sourceDate(page);
      for (const match of matches) {
        const link = {
          from_id: page.id,
          from_source_id: page.source_id,
          from_slug: page.slug,
          to_id: match.entity.id,
          to_source_id: match.entity.source_id,
          to_slug: match.entity.slug,
          link_type: match.link_type,
          link_source: 'manual',
          matched_alias: match.entity.matched_alias,
          evidence: match.entity.evidence,
          participant: match.participant.raw,
          context: [
            'gbrain-granola-propagation',
            `participant=${match.participant.raw}`,
            `evidence=${match.entity.evidence}`,
            `source=${page.slug}`,
          ].join('; ').slice(0, 1000),
        };
        link.key = crypto.createHash('md5')
          .update(`${link.from_source_id}:${link.from_slug}>${link.to_source_id}:${link.to_slug}:${link.link_type}:${link.link_source}`)
          .digest('hex');
        links.push(link);

        if (date) {
          const summary = `${match.link_type === 'attendee' ? 'Attended Granola meeting' : 'Company represented in Granola meeting'}: ${titleSummary(page)}`.slice(0, 240);
          const timeline = {
            page_id: match.entity.id,
            source_id: match.entity.source_id,
            slug: match.entity.slug,
            date,
            source: `gbrain-granola-propagation:${page.slug}`.slice(0, 500),
            summary,
            detail: [
              `Meeting page: ${page.slug}`,
              `Granola ID: ${(page.frontmatter || {}).granola_id || ''}`,
              `Participant: ${match.participant.raw}`,
              `Evidence: ${match.entity.evidence}`,
            ].join('\n'),
            from_slug: page.slug,
          };
          timeline.key = crypto.createHash('md5')
            .update(`${timeline.source_id}:${timeline.slug}:${timeline.date}:${timeline.summary}`)
            .digest('hex');
          timelines.push(timeline);
        }
      }
    }

    const uniqueLinks = [...new Map(links.map((l) => [l.key, l])).values()];
    const uniqueTimelines = [...new Map(timelines.map((t) => [t.key, t])).values()];
    const { linkKeys, timelineKeys } = await existingKeys(sql, uniqueLinks, uniqueTimelines);
    const pendingLinksAll = uniqueLinks.filter((l) => !linkKeys.has(l.key));
    const pendingTimelinesAll = uniqueTimelines.filter((t) => !timelineKeys.has(t.key));
    const pendingLinks = maxNewLinks > 0 ? pendingLinksAll.slice(0, maxNewLinks) : pendingLinksAll;
    const pendingTimelines = maxNewTimelines > 0 ? pendingTimelinesAll.slice(0, maxNewTimelines) : pendingTimelinesAll;

    let insertedLinks = 0;
    let insertedTimelines = 0;
    if (apply) {
      insertedLinks = await insertLinks(sql, pendingLinks);
      insertedTimelines = await insertTimelines(sql, pendingTimelines);
    }

    const report = {
      ok: true,
      mode: shadow ? 'shadow' : (apply ? 'apply' : 'dry-run'),
      shadow,
      applied: apply,
      state_advanced: false,
      database_config_source: cfg.source || 'unknown',
      meetings_scanned: meetings.length,
      canonical_entities: entities.length,
      canonical_entities_active: filteredEntities.length,
      excluded_slugs: [...excludedSlugs],
      person_email_keys: index.personByEmail.size,
      person_name_keys: index.personByName.size,
      company_name_keys: index.companyByName.size,
      company_domain_keys: index.companyByDomain.size,
      suppressed_keys: index.suppressed.length,
      participants_seen: scanned.reduce((n, r) => n + r.participants, 0),
      matched_participants: scanned.reduce((n, r) => n + r.matches, 0),
      link_candidates_total: uniqueLinks.length,
      link_candidates_new_total: pendingLinksAll.length,
      link_candidates_new_selected: pendingLinks.length,
      timeline_candidates_total: uniqueTimelines.length,
      timeline_candidates_new_total: pendingTimelinesAll.length,
      timeline_candidates_new_selected: pendingTimelines.length,
      links_inserted: insertedLinks,
      timeline_entries_inserted: insertedTimelines,
      would_insert_links: pendingLinks.length,
      would_insert_timeline_entries: pendingTimelines.length,
      top_target_entities: summarizeBySlug(pendingLinks, 'to_slug'),
      top_timeline_entities: summarizeBySlug(pendingTimelines, 'slug'),
      examples: pendingLinks.slice(0, verbose ? 25 : 8).map((l) => ({
        from: l.from_slug,
        to: l.to_slug,
        type: l.link_type,
        participant: l.participant,
        evidence: l.evidence,
      })),
      suppressed_examples: index.suppressed.slice(0, verbose ? 25 : 8),
      run_id: stableHash(JSON.stringify({
        meetings: meetings.length,
        entities: filteredEntities.length,
        links: pendingLinksAll.length,
        timelines: pendingTimelinesAll.length,
      })),
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`GBrain Granola propagation (${report.mode})`);
      console.log(`Meetings scanned: ${report.meetings_scanned}`);
      console.log(`Canonical entities: ${report.canonical_entities_active} active of ${report.canonical_entities}`);
      if (report.excluded_slugs.length) console.log(`Excluded entities: ${report.excluded_slugs.join(', ')}`);
      console.log(`Entity keys: ${report.person_email_keys} person emails, ${report.person_name_keys} person names, ${report.company_name_keys} company names, ${report.company_domain_keys} company domains`);
      console.log(`Participants: ${report.participants_seen} seen, ${report.matched_participants} matched`);
      console.log(`Links: ${report.link_candidates_new_selected} selected from ${report.link_candidates_new_total} new / ${report.link_candidates_total} candidates${apply ? `, ${report.links_inserted} inserted` : ''}`);
      console.log(`Timeline: ${report.timeline_candidates_new_selected} selected from ${report.timeline_candidates_new_total} new / ${report.timeline_candidates_total} candidates${apply ? `, ${report.timeline_entries_inserted} inserted` : ''}`);
      if (!apply) console.log('Dry-run only. Re-run with --apply to write.');
      if (report.top_target_entities.length) {
        console.log('Top target entities:');
        for (const row of report.top_target_entities.slice(0, 8)) console.log(`  ${row.slug}: ${row.count}`);
      }
      if (report.examples.length) {
        console.log('Examples:');
        for (const row of report.examples) console.log(`  ${row.from} -> ${row.to} (${row.type}, ${row.evidence})`);
      }
    }
  } finally {
    try { await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`; } catch {}
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  if (json) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});
