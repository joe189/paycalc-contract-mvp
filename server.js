import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);

await loadEnv();

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

    if (req.method === 'POST' && url.pathname === '/api/contracts/generate') {
      const body = await readJsonBody(req);
      const docx = await generateContractDocx(body || {});
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      const filename = safeFilename(`contract-${body?.jobId || 'draft'}-${timestamp}.docx`);
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
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const requestedPath = safePath === '/' ? '/index.html' : safePath;
  const filePath = path.join(__dirname, 'public', requestedPath);
  const publicRoot = path.join(__dirname, 'public');

  if (!filePath.startsWith(publicRoot)) {
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

  return writeZipWithSystemZip(entries);
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
  };
}

function transformContractXml(xml, values) {
  return stripProofingMarkers(replaceTemplateParagraphs(xml, values));
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
  const nextTexts = textMatches.map((match) => match[2]);

  for (let i = 0; i < nextTexts.length; i += 1) {
    if (!nextTexts[i].includes('{{')) continue;
    for (let j = i; j < nextTexts.length; j += 1) {
      const joined = nextTexts.slice(i, j + 1).join('');
      const match = joined.match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
      if (!match) continue;
      nextTexts[i] = values[match[1]] == null ? '' : String(values[match[1]]);
      for (let k = i + 1; k <= j; k += 1) nextTexts[k] = '';
      i = j;
      break;
    }
  }

  let textIndex = 0;
  return paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_match, attrs = '') => {
    const value = nextTexts[textIndex] || '';
    textIndex += 1;
    return `<w:t${attrs}>${escapeXml(value)}</w:t>`;
  });
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
