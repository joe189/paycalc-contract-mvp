import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);

await loadEnv();
const db = await openDatabase();
initDatabase(db);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, product: 'paycalc-contract-mvp' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/jobdiva/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.replace('/api/jobdiva/jobs/', '')).trim();
      if (!jobId) {
        return sendJson(res, 400, { error: 'JobID is required.' });
      }

      const job = process.env.JOBDIVA_LOOKUP_URL
        ? await fetchJobDivaJob(jobId)
        : buildDemoJob(jobId);

      return sendJson(res, 200, {
        source: process.env.JOBDIVA_LOOKUP_URL ? 'jobdiva' : 'demo',
        job,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/facilities/search') {
      const q = url.searchParams.get('q') || '';
      return sendJson(res, 200, { facilities: searchFacilities(q) });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/facilities') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Admin password required.' });
      return sendJson(res, 200, { facilities: listAdminFacilities() });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/facilities/approve') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Admin password required.' });
      const body = await readJsonBody(req);
      return sendJson(res, 200, { facility: approveFacility(body || {}) });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/facilities/reject') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Admin password required.' });
      const body = await readJsonBody(req);
      rejectFacility(body?.id);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/facilities/aliases') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { error: 'Admin password required.' });
      const body = await readJsonBody(req);
      return sendJson(res, 200, { aliases: addFacilityAliases(body?.facilityId, body?.aliases || []) });
    }

    if (req.method === 'POST' && url.pathname === '/api/contracts/generate') {
      const body = await readJsonBody(req);
      const facilityResult = saveFacilitySubmission(body || {});
      const contractPayload = facilityResult.contractPayload || body || {};
      const docx = await generateContractDocx(contractPayload);
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const filename = safeFilename(`contract-${contractPayload?.jobId || 'draft'}-${timestamp}.docx`);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      });
      return res.end(docx);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || 'Server error.' });
  }
});

server.listen(port, () => {
  console.log(`PayCalc Contract MVP running on http://localhost:${port}`);
});

async function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const text = await fs.readFile(envPath, 'utf8').catch(() => '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(urlPath, res) {
  const decodedPath = decodeURIComponent(urlPath || '/').replace(/\\/g, '/');
  const safePath = path.posix.normalize(decodedPath).replace(/^(\.\.\/)+/, '');
  const requestedPath = safePath === '/'
    ? '/index.html'
    : safePath === '/admin/facilities'
      ? '/admin-facilities.html'
      : safePath;
  const relativePath = requestedPath.replace(/^\/+/, '');
  const filePath = path.join(__dirname, 'public', relativePath);
  const publicRoot = path.join(__dirname, 'public');

  if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
    return sendText(res, 403, 'Forbidden');
  }

  const data = await fs.readFile(filePath).catch(() => null);
  if (!data) {
    return sendText(res, 404, 'Not found');
  }

  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  res.end(data);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function sendText(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(value);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function openDatabase() {
  const defaultPath = path.join(__dirname, 'data', 'paycalc.sqlite');
  const dbPath = process.env.PAYCALC_DB_PATH || defaultPath;
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  return database;
}

function initDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS facilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      street TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT NOT NULL DEFAULT '',
      raw_examples TEXT NOT NULL DEFAULT '[]',
      submission_count INTEGER NOT NULL DEFAULT 0,
      last_job_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      locked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_facilities_status ON facilities(status);
    CREATE INDEX IF NOT EXISTS idx_facilities_match ON facilities(normalized_name, city, state);

    CREATE TABLE IF NOT EXISTS facility_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facility_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE CASCADE
    );
  `);
}

function isAdminRequest(req) {
  const configured = process.env.ADMIN_PASSWORD || '';
  if (!configured) return true;
  return req.headers['x-admin-password'] === configured;
}

function saveFacilitySubmission(payload) {
  const cleaned = cleanFacilityPayload(payload);
  const hasFacility = cleaned.facilityName && cleaned.facilityCity && cleaned.facilityState;
  if (!hasFacility) return { status: 'skipped', contractPayload: { ...payload, ...cleaned } };

  const locked = findLockedFacility(cleaned);
  if (locked) {
    return {
      status: 'matched_locked',
      facility: locked,
      contractPayload: { ...payload, ...facilityPayloadFromRecord(locked) },
    };
  }

  const pending = findPendingFacility(cleaned);
  const now = new Date().toISOString();
  const rawExample = buildRawFacilityExample(payload, cleaned);

  if (pending) {
    const rawExamples = appendRawExample(pending.raw_examples, rawExample);
    db.prepare(`
      UPDATE facilities
      SET canonical_name = ?, normalized_name = ?, street = ?, city = ?, state = ?, zip = ?,
          raw_examples = ?, submission_count = submission_count + 1, last_job_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleaned.facilityName,
      normalizeFacilityName(cleaned.facilityName),
      cleaned.facilityAddress,
      cleaned.facilityCity,
      cleaned.facilityState,
      cleaned.facilityZip,
      JSON.stringify(rawExamples),
      stringOr(payload.jobId, ''),
      now,
      pending.id,
    );
    return { status: 'updated_pending', contractPayload: { ...payload, ...cleaned } };
  }

  db.prepare(`
    INSERT INTO facilities (
      canonical_name, normalized_name, street, city, state, zip, status, raw_examples,
      submission_count, last_job_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)
  `).run(
    cleaned.facilityName,
    normalizeFacilityName(cleaned.facilityName),
    cleaned.facilityAddress,
    cleaned.facilityCity,
    cleaned.facilityState,
    cleaned.facilityZip,
    JSON.stringify([rawExample]),
    stringOr(payload.jobId, ''),
    now,
    now,
  );

  return { status: 'created_pending', contractPayload: { ...payload, ...cleaned } };
}

function cleanFacilityPayload(payload) {
  return {
    facilityName: cleanFacilityName(payload.facilityName),
    facilityAddress: cleanStreetAddress(payload.facilityAddress),
    facilityCity: titleCase(payload.facilityCity),
    facilityState: cleanState(payload.facilityState),
    facilityZip: cleanZip(payload.facilityZip),
  };
}

function buildRawFacilityExample(payload, cleaned) {
  return {
    at: new Date().toISOString(),
    jobId: stringOr(payload.jobId, ''),
    rawFacilityName: stringOr(payload.facilityName, ''),
    rawStreet: stringOr(payload.facilityAddress, ''),
    rawCity: stringOr(payload.facilityCity, ''),
    rawState: stringOr(payload.facilityState, ''),
    rawZip: stringOr(payload.facilityZip, ''),
    cleaned,
  };
}

function appendRawExample(rawJson, example) {
  const parsed = JSON.parse(rawJson || '[]');
  parsed.push(example);
  return parsed.slice(-12);
}

function findLockedFacility(cleaned) {
  const normalizedName = normalizeFacilityName(cleaned.facilityName);
  const alias = db.prepare(`
    SELECT f.*
    FROM facility_aliases a
    JOIN facilities f ON f.id = a.facility_id
    WHERE f.status = 'locked' AND a.normalized_alias = ?
    LIMIT 1
  `).get(normalizedName);
  if (alias) return alias;

  return db.prepare(`
    SELECT *
    FROM facilities
    WHERE status = 'locked'
      AND normalized_name = ?
      AND city = ?
      AND state = ?
    LIMIT 1
  `).get(normalizedName, cleaned.facilityCity, cleaned.facilityState);
}

function findPendingFacility(cleaned) {
  return db.prepare(`
    SELECT *
    FROM facilities
    WHERE status = 'pending'
      AND normalized_name = ?
      AND city = ?
      AND state = ?
    LIMIT 1
  `).get(normalizeFacilityName(cleaned.facilityName), cleaned.facilityCity, cleaned.facilityState);
}

function facilityPayloadFromRecord(record) {
  return {
    facilityName: record.canonical_name,
    facilityAddress: record.street,
    facilityCity: record.city,
    facilityState: record.state,
    facilityZip: record.zip,
  };
}

function searchFacilities(query) {
  const q = normalizeFacilityName(query);
  if (q.length < 2) return [];
  const like = `%${q}%`;
  const rows = [
    ...db.prepare(`
    SELECT f.*, a.alias AS matched_alias
    FROM facility_aliases a
    JOIN facilities f ON f.id = a.facility_id
    WHERE f.status = 'locked' AND a.normalized_alias LIKE ?
    ORDER BY f.canonical_name, LENGTH(a.alias)
    LIMIT 12
  `).all(like),
    ...db.prepare(`
      SELECT f.*, NULL AS matched_alias
      FROM facilities f
      WHERE f.status = 'locked' AND f.normalized_name LIKE ?
      ORDER BY f.canonical_name
      LIMIT 12
    `).all(like),
  ];

  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).slice(0, 12).map((row) => ({
    id: row.id,
    facilityName: row.canonical_name,
    facilityAddress: row.street,
    facilityCity: row.city,
    facilityState: row.state,
    facilityZip: row.zip,
    matchedAlias: row.matched_alias || '',
  }));
}

function listAdminFacilities() {
  const rows = db.prepare(`
    SELECT *
    FROM facilities
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC
  `).all();

  const aliasRows = db.prepare('SELECT facility_id, alias FROM facility_aliases ORDER BY alias').all();
  const aliasMap = new Map();
  for (const row of aliasRows) {
    if (!aliasMap.has(row.facility_id)) aliasMap.set(row.facility_id, []);
    aliasMap.get(row.facility_id).push(row.alias);
  }

  return rows.map((row) => ({
    id: row.id,
    facilityName: row.canonical_name,
    facilityAddress: row.street,
    facilityCity: row.city,
    facilityState: row.state,
    facilityZip: row.zip,
    status: row.status,
    notes: row.notes,
    aliases: aliasMap.get(row.id) || [],
    rawExamples: JSON.parse(row.raw_examples || '[]'),
    submissionCount: row.submission_count,
    lastJobId: row.last_job_id,
    updatedAt: row.updated_at,
    lockedAt: row.locked_at,
  }));
}

function approveFacility(input) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Facility ID is required.');

  const cleaned = cleanFacilityPayload({
    facilityName: input.facilityName,
    facilityAddress: input.facilityAddress,
    facilityCity: input.facilityCity,
    facilityState: input.facilityState,
    facilityZip: input.facilityZip,
  });
  if (!cleaned.facilityName || !cleaned.facilityCity || !cleaned.facilityState) {
    throw new Error('Facility name, city, and state are required.');
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE facilities
    SET canonical_name = ?, normalized_name = ?, street = ?, city = ?, state = ?, zip = ?,
        status = 'locked', notes = ?, updated_at = ?, locked_at = COALESCE(locked_at, ?)
    WHERE id = ?
  `).run(
    cleaned.facilityName,
    normalizeFacilityName(cleaned.facilityName),
    cleaned.facilityAddress,
    cleaned.facilityCity,
    cleaned.facilityState,
    cleaned.facilityZip,
    stringOr(input.notes, ''),
    now,
    now,
    id,
  );

  addFacilityAliases(id, Array.isArray(input.aliases) ? input.aliases : splitAliasText(input.aliases || ''));

  return listAdminFacilities().find((facility) => facility.id === id);
}

function rejectFacility(idValue) {
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Facility ID is required.');
  db.prepare("DELETE FROM facilities WHERE id = ? AND status = 'pending'").run(id);
}

function addFacilityAliases(facilityIdValue, aliases) {
  const facilityId = Number(facilityIdValue);
  if (!Number.isInteger(facilityId) || facilityId <= 0) throw new Error('Facility ID is required.');
  const now = new Date().toISOString();
  const values = Array.isArray(aliases) ? aliases : splitAliasText(aliases);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO facility_aliases (facility_id, alias, normalized_alias, created_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const alias of values) {
    const cleaned = cleanFacilityName(alias);
    const normalized = normalizeFacilityName(cleaned);
    if (normalized.length < 2) continue;
    insert.run(facilityId, cleaned, normalized, now);
  }

  return db.prepare('SELECT alias FROM facility_aliases WHERE facility_id = ? ORDER BY alias')
    .all(facilityId)
    .map((row) => row.alias);
}

function splitAliasText(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function generateContractDocx(payload) {
  const templatePath = path.join(__dirname, 'templates', 'contract-template.docx');
  const template = await fs.readFile(templatePath);
  const entries = readZip(template);
  const values = contractValues(payload);

  for (const entry of entries) {
    if (entry.name === 'word/document.xml') {
      entry.data = Buffer.from(transformContractXml(entry.data.toString('utf8'), values), 'utf8');
    }
  }

  return writeZipWithSystemZip(sanitizeContractEntries(entries));
}

function sanitizeContractEntries(entries) {
  return entries
    .filter((entry) => !entry.name.startsWith('customXml/'))
    .map((entry) => {
      if (entry.name === '[Content_Types].xml') {
        return {
          ...entry,
          data: Buffer.from(stripCustomXmlContentTypes(entry.data.toString('utf8')), 'utf8'),
        };
      }

      if (entry.name === 'word/_rels/document.xml.rels') {
        return {
          ...entry,
          data: Buffer.from(stripCustomXmlRelationships(entry.data.toString('utf8')), 'utf8'),
        };
      }

      return entry;
    });
}

function stripCustomXmlContentTypes(xml) {
  return xml.replace(/<Override\b(?=[^>]*\bPartName="\/customXml\/itemProps\d+\.xml")[^>]*\/>/g, '');
}

function stripCustomXmlRelationships(xml) {
  return xml.replace(/<Relationship\b(?=[^>]*\bType="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/customXml")[^>]*\/>/g, '');
}

function contractValues(payload) {
  const firstName = String(payload.contractorName || '').trim().split(/\s+/)[0] || 'there';
  const shift = String(payload.shift || '').trim();
  const schedule = String(payload.schedule || '').trim();
  return {
    contractorName: stringOr(payload.contractorName, 'Contractor'),
    contractorFirstName: firstName,
    contractorAddress1: stringOr(payload.contractorAddress1, ''),
    contractorAddress2: stringOr(payload.contractorAddress2, ''),
    contractDate: formatLongDate(new Date()),
    todaysDate: formatLongDate(new Date()),
    jobTitle: stringOr(payload.jobTitle, ''),
    facilityName: stringOr(payload.facilityName, ''),
    facilityAddress: stringOr(payload.facilityAddress, ''),
    facilityCity: stringOr(payload.facilityCity, ''),
    facilityState: stringOr(payload.facilityState, ''),
    facilityZip: stringOr(payload.facilityZip, ''),
    facilityCityStateZip: formatCityStateZip(payload.facilityCity, payload.facilityState, payload.facilityZip),
    startDate: formatLongDate(payload.startDate),
    endDate: formatLongDate(payload.endDate),
    assignmentWeeks: `${stringOr(payload.assignmentWeeks, '0')} Weeks`,
    scheduleLine: [schedule, shift].filter(Boolean).join(' '),
    hoursPerWeek: `${stringOr(payload.hours, '0')} hours`,
    weeklyGross: money(payload.weeklyGross),
    taxableHourly: `${money(payload.taxableHourly)}/hr`,
    stipend: money(payload.stipendApplied),
    chargeRate: `${money(payload.taxableHourly)}/hr`,
    onCallPay: `${money(payload.onCallPay)}/hr`,
    callBackRate: `${money(payload.otHourly)}/hr`,
    overtimeRate: `${money(payload.otHourly)}/hr`,
    holidayRate: `${money(payload.otHourly)}/hr`,
    requestedTimeOff: stringOr(payload.requestedTimeOff, ''),
    extensionBonus: optionalMoney(payload.extensionBonus),
    payScheduleFrequency: payScheduleFrequencyText(payload.payFrequency),
  };
}

function payScheduleFrequencyText(value) {
  return String(value || '').toUpperCase() === 'WEEKLY'
    ? 'weekly'
    : 'biweekly (every other Friday) in accordance with Trailblazer payroll schedule';
}

function transformContractXml(xml, values) {
  return cleanIgnorablePrefixes(stripProofingMarkers(replaceTemplateParagraphs(xml, values)));
}

function cleanIgnorablePrefixes(xml) {
  return xml.replace(/<[^!?][^>]*\bmc:Ignorable="([^"]+)"[^>]*>/, (tag, prefixes) => {
    const declared = new Set([...tag.matchAll(/\bxmlns:([A-Za-z0-9_]+)=/g)].map((match) => match[1]));
    const kept = prefixes.split(/\s+/).filter((prefix) => declared.has(prefix));
    return tag.replace(/\bmc:Ignorable="[^"]*"/, kept.length ? `mc:Ignorable="${kept.join(' ')}"` : '');
  });
}

function stripProofingMarkers(xml) {
  return xml.replace(/<w:proofErr\b[^>]*\/>/g, '');
}

function replaceTemplateParagraphs(xml, values) {
  return xml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    const text = paragraphText(paragraph);
    if (!text.includes('{{')) return paragraph;
    if (text.includes('{{requestedTimeOff}}') && !values.requestedTimeOff) return '';
    if (text.includes('{{extensionBonus}}') && !values.extensionBonus) return '';
    return replacePlaceholdersInParagraph(paragraph, values);
  });
}

function replacePlaceholdersInParagraph(paragraph, values) {
  const textMatches = [...paragraph.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
  const nextTexts = textMatches.map((match) => unescapeXml(match[2]));
  const fullText = nextTexts.join('');
  const ranges = [];
  let cursor = 0;

  for (let i = 0; i < nextTexts.length; i += 1) {
    ranges.push({ start: cursor, end: cursor + nextTexts[i].length });
    cursor += nextTexts[i].length;
  }

  const placeholders = [...fullText.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].reverse();
  for (const placeholder of placeholders) {
    const start = placeholder.index;
    const end = start + placeholder[0].length;
    const startPosition = findTextPosition(ranges, start);
    const endPosition = findTextPosition(ranges, end - 1);
    if (!startPosition || !endPosition) continue;

    const value = values[placeholder[1]] == null ? '' : String(values[placeholder[1]]);
    const startText = nextTexts[startPosition.index];
    const endText = nextTexts[endPosition.index];

    if (startPosition.index === endPosition.index) {
      nextTexts[startPosition.index] =
        startText.slice(0, startPosition.offset) + value + startText.slice(endPosition.offset + 1);
      continue;
    }

    nextTexts[startPosition.index] = startText.slice(0, startPosition.offset) + value;
    for (let i = startPosition.index + 1; i < endPosition.index; i += 1) {
      nextTexts[i] = '';
    }
    nextTexts[endPosition.index] = endText.slice(endPosition.offset + 1);
  }

  let textIndex = 0;
  return paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_match, attrs = '') => {
    const value = nextTexts[textIndex] || '';
    textIndex += 1;
    return `<w:t${attrs}>${escapeXml(value)}</w:t>`;
  });
}

function findTextPosition(ranges, absoluteIndex) {
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    if (absoluteIndex >= range.start && absoluteIndex < range.end) {
      return { index: i, offset: absoluteIndex - range.start };
    }
  }
  return null;
}

function replaceParagraphByPrefix(xml, prefix, replacement) {
  return xml.replace(/<w:p[\s\S]*?<\/w:p>/g, (paragraph) => {
    const text = paragraphText(paragraph);
    if (!text.startsWith(prefix)) return paragraph;
    const textMatches = [...paragraph.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
    if (!textMatches.length) return paragraph;

    let usedFirst = false;
    return paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_match, attrs = '') => {
      if (!usedFirst) {
        usedFirst = true;
        return `<w:t${attrs}>${escapeXml(replacement)}</w:t>`;
      }
      return `<w:t${attrs}></w:t>`;
    });
  });
}

function paragraphText(paragraph) {
  return [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => unescapeXml(match[1]))
    .join('')
    .trim();
}

function readZip(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid DOCX central directory.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed);
    entries.push({ name, data, directory: name.endsWith('/') });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function writeZipWithSystemZip(entries) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paycalc-docx-'));
  const outputPath = path.join(tempDir, 'contract.docx');

  try {
    const fileNames = [];
    for (const entry of entries) {
      if (entry.directory) continue;
      const safeName = path.posix.normalize(entry.name);
      if (safeName.startsWith('../') || path.posix.isAbsolute(safeName)) {
        throw new Error('Invalid DOCX entry path.');
      }

      const filePath = path.join(tempDir, ...safeName.split('/'));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, entry.data);
      fileNames.push(safeName);
    }

    await execFileAsync('zip', ['-X', '-q', outputPath, ...fileNames], { cwd: tempDir });
    return await fs.readFile(outputPath);
  } catch (error) {
    console.warn('System zip failed, falling back to internal DOCX writer:', error?.message || error);
    return writeZip(entries);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (46 << 9) | (1 << 5) | 1; // 2026-01-01

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.directory ? 0 : 8;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.directory ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Invalid DOCX file.');
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function stringOr(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanFacilityName(value) {
  const text = stringOr(value, '');
  if (!text) return '';
  const expanded = expandFacilityWords(text);
  return titleCase(expanded)
    .replace(/\bOSU\b/gi, 'OSU')
    .replace(/\bU\.?S\.?A\b/gi, 'USA')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFacilityName(value) {
  return expandFacilityWords(value)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\bTHE\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandFacilityWords(value) {
  let text = stringOr(value, '');
  const replacements = [
    [/\bUNIV\b\.?/gi, 'University'],
    [/\bCTR\b\.?/gi, 'Center'],
    [/\bCNTR\b\.?/gi, 'Center'],
    [/\bMED\b\.?/gi, 'Medical'],
    [/\bHOSP\b\.?/gi, 'Hospital'],
    [/\bST\b\.?/gi, 'Saint'],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function cleanStreetAddress(value) {
  const text = stringOr(value, '');
  if (!text) return '';
  const parts = titleCase(text)
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

  const suffixes = new Map([
    ['Street', 'St'],
    ['St', 'St'],
    ['St.', 'St'],
    ['Avenue', 'Ave'],
    ['Ave', 'Ave'],
    ['Ave.', 'Ave'],
    ['Road', 'Rd'],
    ['Rd', 'Rd'],
    ['Boulevard', 'Blvd'],
    ['Blvd', 'Blvd'],
    ['Drive', 'Dr'],
    ['Dr', 'Dr'],
    ['Lane', 'Ln'],
    ['Ln', 'Ln'],
    ['Court', 'Ct'],
    ['Ct', 'Ct'],
    ['Parkway', 'Pkwy'],
    ['Pkwy', 'Pkwy'],
    ['Highway', 'Hwy'],
    ['Hwy', 'Hwy'],
    ['Suite', 'Suite'],
    ['Ste', 'Suite'],
    ['Unit', 'Unit'],
  ]);
  const directions = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

  return parts.map((part) => {
    const upper = part.toUpperCase();
    if (directions.has(upper)) return upper;
    return suffixes.get(part) || part;
  }).join(' ');
}

function cleanState(value) {
  return stringOr(value, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
}

function cleanZip(value) {
  const text = stringOr(value, '');
  const match = text.match(/\d{5}(?:-\d{4})?/);
  return match ? match[0] : text.replace(/[^\d-]/g, '').slice(0, 10);
}

function titleCase(value) {
  return stringOr(value, '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bIi\b/g, 'II')
    .replace(/\bIii\b/g, 'III')
    .replace(/\bIv\b/g, 'IV')
    .replace(/\bNe\b/g, 'NE')
    .replace(/\bNw\b/g, 'NW')
    .replace(/\bSe\b/g, 'SE')
    .replace(/\bSw\b/g, 'SW')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFilename(name) {
  return String(name || 'contract.docx').replace(/[^a-z0-9._-]+/gi, '-');
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$0';
  return '$' + number.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function optionalMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return money(number);
}

function formatCityStateZip(city, state, zip) {
  const cityText = stringOr(city, '');
  const stateText = stringOr(state, '');
  const zipText = stringOr(zip, '');
  const cityState = [cityText, stateText].filter(Boolean).join(', ');
  return [cityState, zipText].filter(Boolean).join(' ');
}

function formatLongDate(value) {
  const date = value instanceof Date ? value : new Date(`${value || ''}T00:00:00`);
  if (Number.isNaN(date.getTime())) return stringOr(value, '');
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function fetchJobDivaJob(jobId) {
  const baseUrl = process.env.JOBDIVA_LOOKUP_URL;
  const token = process.env.JOBDIVA_API_TOKEN || '';
  const url = new URL(baseUrl);
  url.searchParams.set('jobId', jobId);

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `JobDiva lookup returned ${response.status}.`);
  }

  return normalizeJobDivaJob(data.job || data);
}

function normalizeJobDivaJob(job) {
  return {
    contractorName: job.contractorName || job.candidateName || '',
    jobTitle: job.jobTitle || job.title || '',
    facilityName: job.facilityName || job.company || job.client || '',
    facilityCity: job.facilityCity || job.city || '',
    facilityState: job.facilityState || job.state || '',
    startDate: toDateInput(job.startDate),
    endDate: toDateInput(job.endDate),
    schedule: job.schedule || '',
    shift: job.shift || '',
    billRate: job.billRate ?? '',
    hoursPerWeek: job.hoursPerWeek ?? '',
    onCallBillRate: job.onCallBillRate ?? '',
    payType: job.payType || '',
  };
}

function buildDemoJob(jobId) {
  return {
    jobId,
    contractorName: 'Jane Doe',
    jobTitle: 'CT Technologist',
    facilityName: 'Ohio State University Wexner Medical Center',
    facilityCity: 'Columbus',
    facilityState: 'OH',
    startDate: '2026-06-01',
    endDate: '2026-08-29',
    schedule: '4x10',
    shift: 'Days',
    billRate: 86,
    hoursPerWeek: 40,
    onCallBillRate: 12,
    payType: 'TRAVEL',
  };
}

function toDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}
