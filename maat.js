#!/usr/bin/env node
// Maat, a fraud checker for student submissions: finds similarities between them (Canvas export).
//
// Signals per pair of students:
//   images    same or nearly the same image (md5 + 16x16 grayscale), also from embedded PDFs
//   text      shared sentences (lightly reworded), paraphrased sentences (embeddings),
//             JPlag score, text inside images (OCR)
//   code      Dolos, similarity across the whole project (only outliers relative to the class)
//   links     same online document (Google Docs, Miro, Figma, Canva, ...)
//   files     identical random IDs (Word editing sessions, object ids in exports): one file made from the other
//   metadata  same suspicious generator (python-docx, headless browser, ...) shortly after each other
// Signals per student:
//   links copied from an AI chat (utm_source=chatgpt.com, ...), IDs in an export that are not random,
//   visible link != actual link, document last edited by someone else, a lot of text in little
//   editing time, screenshot of an AI chat, different tool/name than in earlier assignments.
// Groups of 3+ students sharing the same piece are reported as clusters; whatever appears in a large
// part of the class (template, assignment text, logo) is treated as course material and ignored.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import sharp from "sharp";

const TEXT_EXT = new Set([".txt", ".md", ".html", ".css", ".json", ".csv"]);
const CODE_EXT = new Set([".py", ".js", ".ts", ".java", ".c", ".h", ".cpp", ".cs", ".php", ".rb", ".go", ".rs", ".sh"]);  // no .sql: mostly generated exports
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);
const OFFICE_EXT = new Set([".docx", ".pptx", ".xlsx"]);
const XML_EXT = new Set([".drawio", ".xml", ".svg"]);   // diagrams and exports: only their object ids count
const SKIP_DIRS = new Set(["venv", ".venv", "env", "__pycache__", ".git", "node_modules", ".idea", ".vscode", ".vercel"]);
const SUSPECT_GENERATORS = ["python-docx", "python-pptx", "openpyxl", "headlesschrome", "reportlab",
  "wkhtmltopdf", "weasyprint", "pandoc", "chatgpt", "openai", "claude"];
const AI_LINKS = ["utm_source=chatgpt", "utm_source=openai", "utm_source=perplexity", "utm_source=copilot",
  "chatgpt.com/", "chat.openai.com", "claude.ai/", "gemini.google.com", "perplexity.ai", "copilot.microsoft.com"];
const AI_SCREEN = ["chatgpt", "copy code", "kopieer code", "message chatgpt", "ask anything", "regenerate",  // UI text, also Dutch
  "claude.ai", "gemini", "copilot"];

const MIN_IMG = 100;        // ignore smaller images (icons)
const OCR_MIN = 300;        // only run OCR on images at least this wide
export const IMG_DIST = 0.03;   // mean pixel difference on 16x16 grayscale: copy 0.001, nearest other diagram 0.06
const MIN_WORDS = 6;        // shorter sentences don't count
const SHINGLE_SIM = 0.6;    // Jaccard on word 3-grams: (lightly reworded) same sentence
const PARA_SIM = 0.9;       // cosine on sentence embeddings: same content, different words
const NEAR_MINUTES = 60;    // same suspicious generator within this many minutes
const CLUSTER_MIN = 3;      // a group of this many students is a cluster
const COMMON_FRACTION = 0.15;  // in >= 15% of the class (min. 4) = course material; copy rings are rarely larger
const PASTE_WORDS = 300, PASTE_MINUTES = 10;   // this many words in this little editing time = pasted?
const W = "[\\p{L}\\p{N}_À-ÿ]";
const WORD = new RegExp(`${W}+(?:['-]${W}+)*`, "gu");   // words; stray punctuation doesn't count
const EMBED_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const OCR_LANGS = "nld+eng";

const log = (...a) => console.error(...a);

export function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter))
    for (const e of exts) {
      const p = path.join(dir, cmd + e);
      if (dir && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  return null;
}

// on Windows a .cmd (npm's dolos shim) only runs through cmd.exe, which needs the arguments quoted
function spawn(file, args, opts = {}) {
  const o = { encoding: "utf8", maxBuffer: 1 << 30, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"], ...opts };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file))
    return spawnSync([file, ...args].map(a => `"${a}"`).join(" "), { ...o, shell: true });
  return spawnSync(file, args, o);
}

const run = (file, args) => spawn(file, args).stdout || "";
const md5 = b => createHash("md5").update(b).digest("hex");
const decode = b => Buffer.from(b).toString("utf8");
const sorted = xs => [...xs].sort();
const pairKey = (a, b) => [a, b].sort().join("\0");
const pct = v => `${(v * 100).toFixed(0)}%`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "maat-"));

// ponytail: only the XML entities and numeric references, which is all docx and pdftohtml produce
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(parseInt(e[1].toLowerCase() === "x" ? e.slice(2) : e.slice(1), e[1].toLowerCase() === "x" ? 16 : 10)) : ENT[e] ?? m);
const stripTags = s => s.replace(/<[^>]+>/g, "");

// Python fnmatch: * ? [abc] [!abc], case-insensitive on Windows
function fnmatch(name, pat) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i], j = c === "[" ? pat.indexOf("]", i + 2) : -1;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (j > 0) { const cls = pat.slice(i + 1, j); re += "[" + (cls[0] === "!" ? "^" + cls.slice(1) : cls).replace(/\\/g, "\\\\") + "]"; i = j; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "is" : "s").test(name);
}


// ---------- extraction ----------

const emptyDoc = () => ({ text: "", images: [], meta: {}, links: [], ids: [] });

function officeExtract(data) {
  const doc = emptyDoc();
  const z = unzipSync(data), names = Object.keys(z);
  const parts = sorted(names.filter(n =>
    /^(word\/(document|footnotes|endnotes|header\d*|footer\d*)|ppt\/slides\/slide\d+|xl\/sharedStrings)\.xml$/.test(n)));
  for (const part of parts) {
    let xml = decode(z[part]);
    const relsName = part.replace(/([^/]+)$/, "_rels/$1.rels");
    const rels = new Map();
    if (z[relsName]) {
      const r = decode(z[relsName]);
      for (const m of r.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*TargetMode="External"/g)) rels.set(m[1], m[2]);
      for (const m of r.matchAll(/Id="([^"]+)"[^>]*TargetMode="External"[^>]*Target="([^"]+)"/g)) rels.set(m[1], m[2]);
    }
    const seen = new Set();
    for (const [, rid, inner] of xml.matchAll(/<w:hyperlink[^>]*r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g))
      if (rels.has(rid)) {
        doc.links.push([unescape(rels.get(rid)), unescape(stripTags(inner)).trim()]);
        seen.add(rid);
      }
    for (const [rid, t] of rels) if (!seen.has(rid) && t.startsWith("http")) doc.links.push([unescape(t), ""]);
    xml = xml.replace(/<\/w:p>|<\/a:p>|<w:br\/>|<w:tab\/>/g, "\n");
    doc.text += "\n" + unescape(stripTags(xml));
  }
  doc.images = names.filter(n => n.includes("/media/") && IMG_EXT.has(path.extname(n).toLowerCase())).map(n => [n, Buffer.from(z[n])]);
  // Word keeps the id of every editing session (rsid): a file made from someone else's carries their sessions
  if (z["word/settings.xml"]) doc.ids = [...decode(z["word/settings.xml"]).matchAll(/<w:rsid\w* w:val="([0-9A-F]{8})"/g)].map(m => m[1]).filter(randomId);
  for (const name of ["docProps/core.xml", "docProps/app.xml"])
    if (z[name])
      for (const [, k, v] of decode(z[name]).matchAll(/<(?:\w+:)?(creator|lastModifiedBy|created|modified|Application|TotalTime|Words|revision)[^>]*>([^<]*)</g))
        doc.meta[k] = v;
  // embedded documents (e.g. a PDF flowchart inside a docx): include their text, images and links
  for (const n of names) {
    if (!n.includes("/embeddings/")) continue;
    const blob = Buffer.from(z[n]);
    let inner = null;
    const start = blob.indexOf("%PDF");
    if (start >= 0) inner = extractBytes(blob.subarray(start, blob.lastIndexOf("%%EOF") + 5), ".pdf");
    else if (OFFICE_EXT.has(path.extname(n).toLowerCase())) inner = officeExtract(blob);
    if (inner) {
      doc.text += "\n" + inner.text;
      doc.images.push(...inner.images.map(([i, b]) => [n + ":" + i, b]));
      doc.links.push(...inner.links);
    }
  }
  return doc;
}

function pdfExtract(file) {
  const doc = emptyDoc();
  doc.text = run("pdftotext", [file, "-"]);
  for (const line of run("pdfinfo", [file]).split(/\r?\n/)) {
    const i = line.indexOf(":");
    const k = i < 0 ? line : line.slice(0, i);
    if (["Creator", "Producer", "Author", "CreationDate", "ModDate"].includes(k)) doc.meta[k] = line.slice(i + 1).trim();
  }
  const xml = run("pdftohtml", ["-xml", "-i", "-stdout", "-q", file]);
  doc.links = [...xml.matchAll(/<a href="([^"]+)">([^<]*)/g)].filter(m => m[1].startsWith("http"))
    .map(m => [unescape(m[1]), unescape(stripTags(m[2])).trim()]);
  // a visible URL as plain text right below a link (e.g. petsafe.com shown, petlibro.com linked);
  // only when the link above is a title, not a URL. Online documents (Miro, Figma, ...) are the work, not a source.
  const linked = new Set(doc.links.map(([h]) => domain(h)));
  let prev = null;                     // href of the previous text element if it was a title link
  for (const [, el] of xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)) {
    const links = [...el.matchAll(/<a href="(http[^"]+)">([^<]*)/g)].map(m => [unescape(m[1]), unescape(m[2])]);
    const plain = unescape(el.replace(/<a [^>]*>.*?<\/a>|<[^>]+>/g, "")).trim();
    for (const [u] of plain.matchAll(/(?:https?:\/\/|www\.)[^\s<]+/g)) {
      const d = domain(u);
      if (prev && !linked.has(d) && !sharedDoc(u) && looksLikeDomain(d)) doc.links.push([prev, u]);
    }
    const titles = links.filter(([, t]) => t.trim() && !/https?:\/\/|www\.|\.(com|nl|be|org)\b/.test(t.toLowerCase())).map(([h]) => h);
    prev = titles.length ? titles.at(-1) : (!plain && links.length ? prev : null);
  }
  const d = tmpDir();
  try {
    spawn("pdfimages", ["-png", file, path.join(d, "i")]);
    doc.images = sorted(fs.readdirSync(d)).map(f => [f, fs.readFileSync(path.join(d, f))]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  return doc;
}

function extractBytes(data, ext) {
  const d = tmpDir();
  try {
    const p = path.join(d, "embedded" + ext);
    fs.writeFileSync(p, data);
    return extract(p);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

// -> {text, images: [[name, bytes]], meta: {}, links: [[href, visible text]]}
function extract(file) {
  const ext = path.extname(file).toLowerCase();
  const doc = emptyDoc();
  try {
    if (ext === ".pdf") return pdfExtract(file);
    if (OFFICE_EXT.has(ext)) return officeExtract(fs.readFileSync(file));
    if (IMG_EXT.has(ext)) doc.images = [[path.basename(file), fs.readFileSync(file)]];
    else if (TEXT_EXT.has(ext) || CODE_EXT.has(ext)) {
      doc.text = fs.readFileSync(file, "utf8");
      if (TEXT_EXT.has(ext)) doc.links = [...doc.text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(m => [m[0], ""]);
    } else if (XML_EXT.has(ext)) doc.ids = [...fs.readFileSync(file, "utf8").matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).filter(randomId);
  } catch (e) {
    log(`  could not read ${path.basename(file)}: ${e.message}`);
    return emptyDoc();
  }
  return doc;
}


// ---------- images ----------

// 16x16 grayscale like Pillow's convert("L") + BOX resize; null for small or unreadable images.
// (A dHash is too sensitive for diagrams with flat colour blocks.)
export async function signature(data) {
  let px, info;
  try {
    ({ data: px, info } = await sharp(data).toColourspace("srgb").raw().toBuffer({ resolveWithObject: true }));
  } catch {
    return null;
  }
  const { width: w, height: h, channels: ch } = info;
  if (Math.min(w, h) < MIN_IMG) return null;
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    luma[i] = ch >= 3 ? (px[i * ch] * 19595 + px[i * ch + 1] * 38470 + px[i * ch + 2] * 7471 + 0x8000) >> 16 : px[i * ch];
  // box filter: each cell averages the pixels whose centre falls in (start, end]; rows first, then columns
  const span = (len, i) => [Math.floor(i * len / 16 - 0.5) + 1, Math.floor((i + 1) * len / 16 - 0.5) + 1];
  const rows = new Uint8Array(16 * h), out = new Uint8Array(256);
  for (let y = 0; y < h; y++)
    for (let i = 0; i < 16; i++) {
      const [a, b] = span(w, i);
      let s = 0;
      for (let x = a; x < b; x++) s += luma[y * w + x];
      rows[y * 16 + i] = Math.round(s / (b - a));
    }
  for (let j = 0; j < 16; j++) {
    const [a, b] = span(h, j);
    for (let i = 0; i < 16; i++) {
      let s = 0;
      for (let y = a; y < b; y++) s += rows[y * 16 + i];
      out[j * 16 + i] = Math.round(s / (b - a));
    }
  }
  return out;
}

// mean difference per pixel, 0 (equal) .. 1
export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
}

async function thumb(data, size = 160) {
  const b = await sharp(data).removeAlpha().resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  return "data:image/jpeg;base64," + b.toString("base64");
}

const ocrCache = new Map();
// text inside an image via tesseract; '' if tesseract is missing
export async function ocr(data) {
  const key = md5(data);
  if (!ocrCache.has(key)) {
    let out = "";
    try {
      const tess = which("tesseract");
      if (tess && (await sharp(data).metadata()).width >= OCR_MIN) {
        const input = await sharp(data).removeAlpha().png().toBuffer();
        out = spawn(tess, ["stdin", "stdout", "-l", OCR_LANGS], { input }).stdout || "";
      }
    } catch { /* unreadable image: no text */ }
    ocrCache.set(key, out);
  }
  return ocrCache.get(key);
}


// ---------- text ----------

// -> [[normalised sentence, Set of word 3-grams]]
export function sentences(text) {
  const out = [];
  text = text.replace(/(https?:\/\/|www\.)\S+/g, " ");   // links are checked separately
  for (const s of text.split(/(?<=[.!?])\s+|\n\s*\n|\|/)) {
    const words = s.toLowerCase().match(WORD) || [];
    if (words.length >= MIN_WORDS) out.push([words.join(" "), grams(words)]);
  }
  return out;
}

const grams = w => new Set(w.slice(2).map((x, i) => `${w[i]} ${w[i + 1]} ${x}`));

function similar(a, b) {
  const [sa, sb] = [a[1], b[1]];
  if (!sa.size || !sb.size) return a[0] === b[0];
  const n = inter(sa, sb);
  return n / (sa.size + sb.size - n) >= SHINGLE_SIM;
}

export function sharedSentences(xs, ys) {
  const hits = [], seen = new Set();
  const index = new Map();             // 3-gram -> sentences in ys
  for (const y of ys) for (const g of y[1]) index.set(g, [...(index.get(g) || []), y]);
  for (const x of xs) {
    const cands = new Set([...x[1]].flatMap(g => index.get(g) || []));
    for (const y of cands)
      if (similar(x, y) && !seen.has(x[0])) {
        seen.add(x[0]);
        hits.push([x[0], y[0]]);
        break;
      }
  }
  return hits;
}

let model;
// normalised sentence embeddings (transformers.js, local); null if it isn't installed
async function embed(texts) {
  if (model === undefined) {
    let tf;
    try {
      tf = await import("@huggingface/transformers");
    } catch {
      return (model = null);
    }
    tf.env.cacheDir = path.join(os.homedir(), ".maat", "models");
    log(`  loading embedding model (${EMBED_MODEL}; downloaded on first use)`);
    model = await tf.pipeline("feature-extraction", EMBED_MODEL, { dtype: "fp32" });
  }
  if (!model) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const t = await model(texts.slice(i, i + 64), { pooling: "mean", normalize: true });
    const dim = t.dims[1];
    for (let k = 0; k < t.dims[0]; k++) out.push(t.data.slice(k * dim, (k + 1) * dim));
  }
  return out;
}


// ---------- links ----------

export function domain(s) {
  s = s.trim().toLowerCase();
  const host = (s.includes("://") ? s.slice(s.indexOf("://") + 3) : s).split(/[/?#]/)[0].split(":")[0];
  return host.startsWith("www.") ? host.slice(4) : host;
}

const TLDS = new Set(["com", "nl", "be", "org", "net", "io", "de", "eu", "co", "uk", "fr", "ai", "app", "dev", "info", "edu", "gov", "us", "ca"]);

const looksLikeDomain = d => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]+$/.test(d) && TLDS.has(d.split(".").at(-1));

// 'hue.com' (a broken-off piece of philips-hue.com) counts as the same site
const sameSite = (a, b) => a === b || a.endsWith(b) || b.endsWith(a);

// online documents a student works in: two students linking the same one share the work
const SHARED_DOCS = [
  [/miro\.com\/app\/board\/([^/?#]+)/, "Miro board"],
  [/docs\.google\.com\/(?:document|presentation|spreadsheets|forms|drawings)\/d\/([\w-]{20,})/, "Google document"],
  [/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]{20,})/, "Google Drive file"],
  [/figma\.com\/(?:file|design|proto|board)\/(\w{10,})/, "Figma file"],
  [/canva\.com\/design\/([\w-]{8,})/, "Canva design"],
  [/lucid\.app\/lucidchart\/([\w-]{20,})/, "Lucidchart diagram"],
  [/tinkercad\.com\/things\/([\w-]+)/, "Tinkercad design"],
  [/scratch\.mit\.edu\/projects\/(\d+)/, "Scratch project"],
  [/replit\.com\/@([\w-]+\/[\w-]+)/, "Replit"],
  [/codepen\.io\/([\w-]+\/(?:pen|full|details)\/\w+)/, "CodePen"],
  [/notion\.(?:so|site)\/\S*?([0-9a-f]{32})/, "Notion page"],
];
// -> "Miro board uXjV..." for a link to an online document, else null
export function sharedDoc(href) {
  for (const [re, kind] of SHARED_DOCS) {
    const m = href.match(re);
    if (m) return `${kind} ${m[1]}`;
  }
  return null;
}

export function linkFlags(links) {
  const flags = [];
  for (const [href, shown] of links) {
    const h = href.toLowerCase();
    const ai = AI_LINKS.find(p => h.includes(p));
    if (ai) flags.push(`link copied from an AI chat (${ai}): ${href.slice(0, 90)}`);
    const s = shown.trim().toLowerCase();
    if ((s.startsWith("http") || s.startsWith("www.") || /^[a-z0-9.-]+(\/\S*)?$/.test(s || "-"))
        && looksLikeDomain(domain(s)) && !sameSite(domain(s), domain(href)))
      flags.push(`visible link '${shown.slice(0, 50)}' points to ${domain(href)}`);
  }
  return [...new Set(flags)];
}


// ---------- metadata ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseTime(v) {
  v = (v || "").trim().split(/ (?:Romance|CET|CEST|UTC)/)[0];
  let m = v.match(/^(\d{4})-(\d\d?)-(\d\d?)T(\d\d?):(\d\d?):(\d\d?)Z$/);
  if (m) return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  m = v.match(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+([a-z]{3})[a-z]*\s+(\d\d?)\s+(\d\d?):(\d\d):(\d\d)\s+(\d{4})$/i);   // pdfinfo
  if (m && MONTHS.includes(m[1].toLowerCase()))
    return new Date(Date.UTC(+m[6], MONTHS.indexOf(m[1].toLowerCase()), +m[2], +m[3], +m[4], +m[5]));
  return null;
}

const generator = meta => Object.entries(meta).filter(([k, v]) => ["creator", "Creator", "Producer", "Application"].includes(k) && v)
  .map(([, v]) => v).join(" / ");

export function toolFamily(meta) {
  const g = generator(meta).toLowerCase();
  for (const s of SUSPECT_GENERATORS) if (g.includes(s)) return s;
  for (const [k, fam] of [["google docs", "Google Docs"], ["libreoffice", "LibreOffice"], ["writer", "LibreOffice"],
    ["pages", "Pages"], ["quartz", "Pages"], ["word", "Word"]])
    if (g.includes(k)) return fam;
  return g ? "other" : "unknown";
}

function authors(meta, ignore) {
  const out = [];
  for (const k of ["lastModifiedBy", "creator", "Author"]) {
    const who = (meta[k] || "").trim();
    if (who && !ignore.has(who.toLowerCase()) && !who.toLowerCase().includes("python-docx")) out.push([k, who]);
  }
  return out;
}

const toInt = v => { if (!/^\s*[+-]?\d+\s*$/.test(v)) throw new Error("not an int"); return parseInt(v, 10); };

export function studentFlags(student, meta, ignore) {
  const flags = [];
  const fam = toolFamily(meta);
  if (SUSPECT_GENERATORS.includes(fam)) flags.push(`made with ${fam}`);
  for (const [k, who] of authors(meta, ignore)) {
    if (/\d/.test(who) || who.split(/\s+/).length > 4) continue;   // a document title, not a person
    const tokens = (who.toLowerCase().match(/[a-z]+/g) || []).filter(t => t.length > 2);
    if (tokens.length && !tokens.some(t => student.includes(t))) flags.push(`${k} = '${who}' (not the student?)`);
  }
  try {
    const words = toInt(meta.Words ?? "0"), minutes = toInt(meta.TotalTime ?? "-1");
    if (words >= PASTE_WORDS && minutes >= 0 && minutes <= PASTE_MINUTES) flags.push(`${words} words in ${minutes} min editing time (pasted?)`);
  } catch { /* not a number */ }
  return flags;
}


// ---------- history across assignments ----------

function historyFlags(history, student, assignment, meta, ignore) {
  const prev = (history[student] || []).filter(h => h.assignment !== assignment);
  if (!prev.length) return [];
  const flags = [], fam = toolFamily(meta);
  const fams = prev.map(h => h.tool).filter(t => t !== "unknown");
  if (fam !== "unknown" && fams.length && !fams.includes(fam)) {
    const counts = [...new Set(fams)].map(f => `${f} ${fams.filter(x => x === f).length}x`).join(", ");
    flags.push(`different tool than before: now ${fam} (before: ${counts})`);
  }
  const names = new Set(prev.flatMap(h => h.names));
  const now = new Set(authors(meta, ignore).map(([, who]) => who));
  if (names.size && now.size && !inter(now, names))
    flags.push(`different name in metadata than before: ${sorted(now).join(", ")} (before: ${sorted(names).join(", ")})`);
  return flags;
}

function historyUpdate(history, student, assignment, meta, ignore) {
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const entry = { assignment, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    tool: toolFamily(meta), names: sorted(new Set(authors(meta, ignore).map(([, who]) => who))) };
  history[student] = [...(history[student] || []).filter(h => h.assignment !== assignment), entry];
}


// ---------- jplag and dolos (optional) ----------

const safe = name => name.replace(/[^\p{L}\p{N}_-]/gu, "_");

// texts: {student: text}; old: students from earlier years (only new<->old is compared)
function jplagScores(jar, texts, templateText, keepDir, old, skipped) {
  const java = which("java");
  if (!jar || !java) {
    if (Object.keys(texts).length) skipped.push(jar ? "JPlag (Java not found)" : "JPlag (not installed)");
    return new Map();
  }
  const names = Object.fromEntries(Object.keys(texts).map(s => [safe(s), s]));
  const d = tmpDir();
  try {
    for (const [s, t] of Object.entries(texts)) {
      const root = path.join(d, old.has(s) ? "old" : "new", safe(s));
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "text.txt"), t);
    }
    const args = ["-jar", jar, "-l", "text", "-M", "RUN", "-n", "-1", "-r", path.join(d, "res"), path.join(d, "new")];
    if (old.size) args.splice(-1, 0, "-old", path.join(d, "old"));
    if (templateText) {
      fs.mkdirSync(path.join(d, "base"));
      fs.writeFileSync(path.join(d, "base", "text.txt"), templateText);
      args.splice(2, 0, "-bc", path.join(d, "base"));
    }
    spawn(java, args);
    const res = path.join(d, "res.jplag");
    if (!fs.existsSync(res)) {
      log("  JPlag produced no result, skipped");
      skipped.push("JPlag (no result)");
      return new Map();
    }
    if (keepDir) fs.copyFileSync(res, path.join(keepDir, "jplag.jplag"));
    const top = JSON.parse(decode(unzipSync(fs.readFileSync(res))["topComparisons.json"]));
    return new Map(top.map(c => [pairKey(names[c.firstSubmission] ?? c.firstSubmission, names[c.secondSubmission] ?? c.secondSubmission),
      c.similarities.AVG ?? 0]));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const csvField = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

function parseCsv(text) {
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c !== '"') f += c;
      else if (text[i + 1] === '"') { f += '"'; i++; }
      else q = false;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) rows.push([...row, f]);
  const [head = [], ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// codeFiles: {student: [paths]} -> Map(pair -> [project similarity, file_a, file_b]).
// One Dolos run per extension. Project similarity = for each file its best match in the other
// student's work, averaged over all files of both students (one tiny boilerplate file barely counts).
function dolosScores(codeFiles, keepDir, skipped) {
  const dolos = which("dolos");
  if (!dolos) {
    if (Object.keys(codeFiles).length) skipped.push("Dolos (not installed)");
    return new Map();
  }
  const norm = p => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  const owner = new Map(Object.entries(codeFiles).flatMap(([s, ps]) => ps.map(p => [norm(p), s])));
  const byExt = new Map();
  for (const p of owner.keys()) byExt.set(path.extname(p), [...(byExt.get(path.extname(p)) || []), p]);
  const best = new Map(), perFile = new Map();
  const bump = (k, v) => perFile.set(k, Math.max(perFile.get(k) || 0, v));
  for (const [ext, files] of byExt) {
    if (new Set(files.map(p => owner.get(p))).size < 2) continue;
    const d = tmpDir();
    try {
      const out = keepDir ? path.join(keepDir, "dolos" + ext.replace(".", "-")) : path.join(d, "out");
      fs.rmSync(out, { recursive: true, force: true });
      // file list as CSV (on Windows dolos is a .cmd and cmd.exe stops at 8191 characters);
      // Dolos only reads paths relative to the CSV, so the files are copied next to it
      const src = new Map();
      files.forEach((p, i) => {
        const name = `${i}_${path.basename(p)}`;
        fs.copyFileSync(p, path.join(d, name));
        src.set(name, p);
      });
      const info = path.join(d, "info.csv");
      fs.writeFileSync(info, ["filename,full_name,label", ...[...src].map(([n, p]) => [n, n, owner.get(p)].map(csvField).join(","))].join("\r\n") + "\r\n");
      spawn(dolos, ["run", "-f", "csv", "-o", out, info]);
      const csvPath = path.join(out, "pairs.csv");
      if (!fs.existsSync(csvPath)) {
        log(`  Dolos produced no result for ${ext}, skipped`);
        skipped.push(`Dolos (no result for ${ext} files)`);
        continue;
      }
      for (const row of parseCsv(fs.readFileSync(csvPath, "utf8"))) {
        const fa = src.get(path.basename(row.leftFilePath || "")), fb = src.get(path.basename(row.rightFilePath || ""));
        const a = owner.get(fa), b = owner.get(fb);
        if (!a || !b || a === b) continue;
        const key = pairKey(a, b), sim = parseFloat(row.similarity);
        bump(fa + "\0" + b, sim);
        bump(fb + "\0" + a, sim);
        if (sim > (best.get(key)?.[0] ?? 0)) best.set(key, [sim, path.basename(fa), path.basename(fb)]);
      }
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
  const out = new Map();
  for (const [key, [, f1, f2]] of best) {
    const [a, b] = key.split("\0");
    const vals = [...owner].flatMap(([f, s]) => s === a ? [perFile.get(f + "\0" + b) || 0] : s === b ? [perFile.get(f + "\0" + a) || 0] : []);
    out.set(key, [vals.reduce((x, y) => x + y, 0) / vals.length, f1, f2]);
  }
  return out;
}


// ---------- collecting ----------

// Map(student -> [files]); folders (unpacked zips) are read recursively
function collect(folder, prefix = "", exclude = []) {
  const students = new Map();
  const excluded = f => exclude.some(x => fnmatch(f, x));
  const walk = (dir, list) => {
    const es = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of es) if (!e.isDirectory() && !excluded(e.name)) list.push(path.join(dir, e.name));
    for (const e of es) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), list);
  };
  for (const f of sorted(fs.readdirSync(folder))) {
    const p = path.join(folder, f);
    if (!f.includes("_") || excluded(f)) continue;
    const s = prefix + f.split("_")[0];
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st || !(st.isFile() || st.isDirectory())) continue;
    if (!students.has(s)) students.set(s, []);
    if (st.isFile()) students.get(s).push(p);
    else walk(p, students.get(s));
  }
  return students;
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) { this.p[this.find(a)] = this.find(b); }
  groups() {
    const g = new Map();
    this.p.forEach((_, i) => { const r = this.find(i); g.set(r, [...(g.get(r) || []), i]); });
    return [...g.values()];
  }
}

// Groups equal images and sentences across all students.
// Large part of the class -> course material (removed); 3+ students -> cluster.
function findGroups(data, current) {
  const commonMin = Math.max(CLUSTER_MIN + 1, Math.ceil(COMMON_FRACTION * current.size));
  const clusters = [], common = { images: 0, sentences: 0 };

  let items = [...data].flatMap(([s, d]) => d.imgs.map(i => [s, i]));
  if (items.length) {
    const uf = new UnionFind(items.length);
    for (let k = 0; k < items.length; k++)
      for (let j = k + 1; j < items.length; j++)
        if (distance(items[k][1].sig, items[j][1].sig) <= IMG_DIST) uf.union(k, j);
    for (const g of uf.groups()) {
      const who = new Set(g.map(k => items[k][0]));
      if (inter(who, current) >= commonMin) {
        for (const k of g) items[k][1].common = true;
        common.images++;
      } else if (who.size >= CLUSTER_MIN) clusters.push({ kind: "image", students: sorted(who), example: items[g[0]][1].bytes });
    }
    for (const d of data.values()) d.imgs = d.imgs.filter(i => !i.common);
  }

  items = [...data].flatMap(([s, d]) => d.sents.map(x => [s, x]));
  const index = new Map();
  items.forEach(([, x], k) => { for (const g of x[1]) index.set(g, [...(index.get(g) || []), k]); });
  const uf = new UnionFind(items.length);
  items.forEach(([s, x], k) => {
    const cands = new Set([...x[1]].flatMap(g => index.get(g).filter(j => j > k && items[j][0] !== s)));
    for (const j of cands) if (similar(x, items[j][1])) uf.union(k, j);
  });
  const drop = new Set();
  for (const g of uf.groups()) {
    const who = new Set(g.map(k => items[k][0]));
    if (inter(who, current) >= commonMin) {
      for (const k of g) drop.add(items[k][1]);
      common.sentences++;
    } else if (who.size >= CLUSTER_MIN) clusters.push({ kind: "sentence", students: sorted(who), example: items[g[0]][1][0] });
  }
  for (const d of data.values()) d.sents = d.sents.filter(x => !drop.has(x));
  return [clusters, common, commonMin];
}

// Map(pair -> [[sentence_a, sentence_b]]) for sentences with the same content in other words.
// Sentences that match a large part of the class this way don't count (assignment in own words).
async function paraphrases(data, current, commonMin, shared, skipped) {
  const items = [...data].flatMap(([s, d]) => d.sents.map(x => [s, x[0]]));
  if (items.length < 2) return new Map();
  const vec = await embed(items.map(([, t]) => t));
  if (!vec) {
    log("  @huggingface/transformers not installed: paraphrase detection skipped");
    skipped.push("paraphrases (model not installed)");
    return new Map();
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const out = new Map();
  // ponytail: n² dot products, a few seconds for a class; an ANN index if classes get huge
  items.forEach(([s, t], k) => {
    const hit = [];
    for (let j = 0; j < items.length; j++) if (items[j][0] !== s && dot(vec[k], vec[j]) >= PARA_SIM) hit.push(j);
    const who = new Set(hit.map(j => items[j][0]));
    if (!hit.length || inter(who, current) + 1 >= commonMin) return;
    for (const j of hit) {
      if (j > k) continue;
      const key = pairKey(s, items[j][0]), sh = shared.get(key) || new Set();
      if (!sh.has(t + "\0" + items[j][1]) && !sh.has(items[j][1] + "\0" + t)) out.set(key, [...(out.get(key) || []), [t, items[j][1]]]);
    }
  });
  return out;
}


// ---------- analysis ----------

// A tool-generated id: long and varied (16-hex Node-RED ids, uuids, Word rsids, nanoids).
// Readable ("ms_tab") or sequential-looking ("a5f1000000000002") ids are not.
export function randomId(id) {
  return /^[\w.-]{8,}$/.test(id) && (id.match(/\d/g) || []).length >= 2 && (id.match(/[a-z]/gi) || []).length >= 2
    && new Set(id.toLowerCase()).size >= Math.min(8, id.length / 2);
}

// JSON -> { ids: random ids anywhere, exports: id lists of tool exports, code: [[name, ext, source]], text }.
// A tool export is a list of objects that each carry an id and a type (Node-RED, n8n, Excalidraw, ...);
// code inside it (Node-RED function nodes, notebook code cells) goes to Dolos, the JSON itself is no text.
function jsonDoc(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  const out = { ids: [], exports: [], code: [], text: "" };
  const isObj = n => n && typeof n === "object" && !Array.isArray(n);
  const walk = v => {
    if (Array.isArray(v)) {
      if (v.length && v.every(n => isObj(n) && "id" in n && "type" in n)) out.exports.push(v.map(n => String(n.id)));
      v.forEach(walk);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (/^(id|_id|uid|uuid|guid)$/i.test(k) && (typeof x === "string" || typeof x === "number") && randomId(String(x))) out.ids.push(String(x));
        walk(x);
      }
      const src = ["initialize", "func", "finalize"].filter(k => typeof v[k] === "string" && v[k].trim()).map(k => v[k]).join("\n");
      if (src) out.code.push([v.name || String(v.id), ".js", src]);
    }
  };
  walk(j);
  if (Array.isArray(j?.cells)) {   // Jupyter notebook
    const lang = { python: ".py", r: ".r", julia: ".jl", javascript: ".js" }[j.metadata?.kernelspec?.language] || ".py";
    const join = c => Array.isArray(c.source) ? c.source.join("") : String(c.source || "");
    const code = j.cells.filter(c => c.cell_type === "code").map(join).join("\n\n");
    if (code.trim()) out.code.push([path.basename(file, ".ipynb"), lang, code]);
    out.text = j.cells.filter(c => c.cell_type === "markdown").map(join).join("\n\n");
  }
  return out.exports.length || out.code.length || Array.isArray(j?.cells) ? out : { ...out, plain: true };
}

// Tools make random ids: readable or sequential ids (a5f1000000000001, ...02) mean the
// export was written by hand or generated (often by an AI chat), not exported by the tool.
export function handmadeIds(ids) {
  ids = [...ids];
  const hexes = ids.filter(i => /^[0-9a-f]{16}$/.test(i)).map(i => BigInt("0x" + i)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const odd = ids.filter(i => !randomId(i)).length;
  return odd > ids.length / 2 || hexes.slice(1).filter((b, i) => b - hexes[i] < 1000n).length >= 3;
}

async function loadStudent(s, files, tmpl, ignore, useOcr, codeDir) {
  let text = "", meta = {};
  const imgs = [], links = [], flags = [];
  const code = files.filter(f => CODE_EXT.has(path.extname(f).toLowerCase()));
  const ids = new Set();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const j = ext === ".json" || ext === ".ipynb" ? jsonDoc(f) : null;
    if (j) j.ids.forEach(i => ids.add(i));
    if (j && !j.plain) {   // export or notebook: embedded code goes to Dolos
      for (const [name, cext, src] of j.code) {
        const p = path.join(codeDir, `${safe(s)}_${code.length}_${safe(name)}${cext}`);
        fs.writeFileSync(p, src);
        code.push(p);
      }
      text += "\n" + j.text;
      if (j.exports.some(handmadeIds))
        flags.push(`IDs in ${path.basename(f)} are not random (readable or sequential): written or generated, not exported by a tool`);
      continue;
    }
    const doc = extract(f);
    if (!CODE_EXT.has(ext)) text += "\n" + doc.text;   // code goes to Dolos
    imgs.push(...doc.images.map(([n, b]) => [path.basename(f), n, b]));
    links.push(...doc.links);
    doc.ids.forEach(i => ids.add(i));
    if (Object.keys(doc.meta).length && !Object.keys(meta).length) meta = { ...doc.meta };
  }
  const t = parseTime(meta.created || meta.CreationDate);
  if (t) meta._time = t;
  const hashed = [], aiScreens = [];
  let ocrText = "";
  for (const [f, n, b] of imgs) {
    const h = await signature(b);
    if (!h || tmpl.hashes.some(x => distance(h, x) <= IMG_DIST)) continue;
    hashed.push({ file: f, name: n, bytes: b, sig: h, md5: md5(b) });
    if (useOcr) {
      const o = await ocr(b);
      ocrText += "\n" + o;
      const hits = AI_SCREEN.filter(w => o.toLowerCase().includes(w));
      if (hits.length) aiScreens.push(`${n}: ${hits.join(", ")}`);
    }
  }
  const sents = sentences(text + "\n" + ocrText).filter(x =>
    !tmpl.sents.some(y => similar(x, y)) && !(x[1].size && inter(x[1], tmpl.grams) >= 0.6 * x[1].size));
  flags.unshift(...studentFlags(s, meta, ignore), ...linkFlags(links), ...aiScreens.map(x => `image looks like a screenshot of an AI chat (${x})`));
  return { text, sents, imgs: hashed, meta, links, flags, code, ids, files: files.map(f => path.basename(f)) };
}

export async function analyse(folder, { template = null, jar = null, ignore = [], ignoreImages = [], old = [], ocr = true, embed = true,
  dolos = true, history = null, keepDir = null, exclude = [] } = {}) {
  ignore = new Set(ignore.map(i => i.toLowerCase()));
  const t = template ? extract(template) : emptyDoc();
  const hashes = [];
  for (const b of [...t.images.map(([, b]) => b), ...ignoreImages.map(p => fs.readFileSync(p))]) {
    const h = await signature(b);
    if (h) hashes.push(h);
  }
  const tmpl = { text: t.text, sents: sentences(t.text), grams: grams(t.text.toLowerCase().match(WORD) || []), hashes };
  const assignment = path.basename(path.resolve(folder));

  const students = collect(folder, "", exclude);
  const current = new Set(students.keys());
  for (const o of old) for (const [s, fs_] of collect(o, path.basename(path.resolve(o)) + "/", exclude)) students.set(s, fs_);
  const oldNames = new Set([...students.keys()].filter(s => !current.has(s)));

  // ponytail: without keepDir the code taken out of exports and notebooks stays in a temp folder
  const codeDir = keepDir ? path.join(keepDir, "embedded") : tmpDir();
  fs.rmSync(codeDir, { recursive: true, force: true });
  fs.mkdirSync(codeDir, { recursive: true });
  const data = new Map();
  for (const [s, files] of students) {
    const d = await loadStudent(s, files, tmpl, ignore, ocr, codeDir);
    data.set(s, d);
    if (history && current.has(s)) {
      d.flags.push(...historyFlags(history, s, assignment, d.meta, ignore));
      historyUpdate(history, s, assignment, d.meta, ignore);
    }
    log(`  ${s}: ${files.length} file(s), ${d.sents.length} sentences, ${d.imgs.length} images`);
  }

  const [clusters, common, commonMin] = findGroups(data, current);
  const skipped = [];
  if (ocr && !which("tesseract")) skipped.push("text in images (Tesseract not installed)");
  if ([...students.values()].flat().some(f => f.toLowerCase().endsWith(".pdf")) && !which("pdftotext")) skipped.push("PDFs (poppler not installed)");
  const jp = jplagScores(jar, Object.fromEntries([...data].filter(([, d]) => d.text.trim()).map(([s, d]) => [s, d.text])), tmpl.text, keepDir, oldNames, skipped);
  const dl = dolos ? dolosScores(Object.fromEntries([...data].filter(([, d]) => d.code.length).map(([s, d]) => [s, d.code])), keepDir, skipped) : new Map();
  // code from the same lessons always looks alike: only outliers relative to the class count
  const sims = [...dl].filter(([k]) => k.split("\0").every(s => current.has(s))).map(([, v]) => v[0]);
  let dolosMin = 0.8;
  if (sims.length >= 3) {
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    dolosMin = Math.max(0.5, mean + 2 * Math.sqrt(sims.reduce((a, x) => a + (x - mean) ** 2, 0) / sims.length));
  }

  const names = sorted(data.keys()), sharedAll = new Map();
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      if (oldNames.has(a) && oldNames.has(b)) continue;
      sharedAll.set(pairKey(a, b), sharedSentences(data.get(a).sents, data.get(b).sents));
    }
  const para = embed ? await paraphrases(data, current, commonMin,
    new Map([...sharedAll].map(([k, v]) => [k, new Set(v.map(([x, y]) => x + "\0" + y))])), skipped) : new Map();
  // ids and documents in a large part of the class come from the template or a lesson file
  const idCount = new Map(), docCount = new Map();
  const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const docs = s => new Set(data.get(s).links.map(([h]) => sharedDoc(h)).filter(Boolean));
  for (const s of current) {
    for (const i of data.get(s).ids) count(idCount, i);
    for (const d of docs(s)) count(docCount, d);
  }

  const pairs = [];
  for (const [key, shared] of sharedAll) {
    const [a, b] = key.split("\0"), A = data.get(a), B = data.get(b);
    const reasons = [], imgs = [];
    let score = 0;
    for (const x of A.imgs)
      for (const y of B.imgs) {
        const dist = distance(x.sig, y.sig);
        if (x.md5 === y.md5 || dist <= IMG_DIST)
          imgs.push([x.bytes, y.bytes, x.md5 === y.md5 ? "identical file" : `nearly equal (difference ${dist.toFixed(3)})`]);
      }
    if (imgs.length) {
      score += 50;
      reasons.push(plural(imgs.length, "matching image"));
    }
    if (shared.length) {
      score += Math.min(30, 5 * shared.length);
      reasons.push(plural(shared.length, "shared sentence"));
    }
    const p = para.get(key) || [];
    if (p.length >= 2) {   // a single paraphrased sentence is too often a coincidence
      score += Math.min(20, 4 * p.length);
      reasons.push(`${plural(p.length, "paraphrased sentence")} with the same content`);
    }
    const j = jp.get(key) || 0;
    if (j >= 0.1) {
      score += Math.round(50 * j);
      reasons.push(`JPlag ${pct(j)}`);
    }
    const dsim = dl.get(key);
    if (dsim && dsim[0] >= dolosMin) {
      score += Math.round(60 * dsim[0]);
      reasons.push(`Dolos: code ${pct(dsim[0])} similar across the project (class threshold ${pct(dolosMin)}; mainly ${dsim[1]} ~ ${dsim[2]})`);
    }
    const ids = [...A.ids].filter(i => B.ids.has(i) && (idCount.get(i) || 0) < commonMin);
    if (ids.length >= 3) {   // random ids only match when one file was made from the other
      score += 40;
      reasons.push(`${ids.length} identical random IDs in their files (one made from the other)`);
    }
    const bd = docs(b);
    const same = [...docs(a)].filter(d => bd.has(d) && (docCount.get(d) || 0) < commonMin);
    if (same.length) {
      score += 40;
      reasons.push(`same online document (${same.join(", ")})`);
    }
    const fa = toolFamily(A.meta), fb = toolFamily(B.meta);
    if (fa === fb && SUSPECT_GENERATORS.includes(fa)) {
      score += 15;
      reasons.push(`both made with ${fa}`);
      const [ta, tb] = [A.meta._time, B.meta._time];
      if (ta && tb && Math.abs(ta - tb) <= NEAR_MINUTES * 60000) {
        score += 10;
        reasons.push(`created ${(Math.abs(ta - tb) / 60000).toFixed(0)} min apart`);
      }
    }
    if (score) pairs.push({ a, b, score, reasons, imgs, shared, para: p, old: oldNames.has(a) || oldNames.has(b) });
  }
  pairs.sort((x, y) => y.score - x.score);
  const cmp = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  const codeTop = [...dl].map(([k, v]) => [v[0], ...k.split("\0"), v[1], v[2]]).sort((x, y) => cmp(y, x)).slice(0, 10);
  return { data, pairs, clusters, common, commonMin, codeTop, dolosMin, current, old: oldNames, skipped };
}


// ---------- report ----------

export const why = p => (p.old ? "earlier year: " : "") + p.reasons.join(", ");

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

// signal tags for filtering, read off the reasons analyse() wrote
const KINDS = [[/matching image/, "image"], [/shared sentence/, "shared text"], [/paraphrased/, "paraphrase"], [/^JPlag/, "text similarity"],
  [/^Dolos/, "code"], [/random IDs/, "file IDs"], [/online document/, "online document"], [/both made with|min apart/, "generator"]];
const kindsOf = p => [...new Set(p.reasons.flatMap(r => KINDS.filter(([re]) => re.test(r)).map(([, k]) => k)))];

const CSS = `
:root{--bg:#f1e9d7;--raised:#f8f3e8;--rule:#d9ccb2;--text:#0b3a4e;--muted:#4d6470;--accent:#b3290c;--accent-soft:#f6cdb9;--vermilion:#f13e21;
--bar:#06364a;--bar-text:#f1e9d7;--bar-muted:#a9bcbc;--bar-accent:#ff7a55;
--grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .95 0 0 0 0 .91 0 0 0 0 .84 0 0 0 9 -5.4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.22' filter='url(%23n)'/%3E%3C/svg%3E");
color-scheme:light;scrollbar-color:var(--rule) var(--bg)}
@media (prefers-color-scheme:dark){:root{--bg:#072f40;--raised:#0d3b50;--rule:#1f4e62;--text:#f1e9d7;--muted:#9fb3b4;--accent:#ff6a45;--accent-soft:#5a2a1f;--vermilion:#ff6a45;--bar:#042536;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
::selection{background:var(--accent-soft);color:var(--text)}
input,select{caret-color:var(--accent)}
a{color:var(--accent);text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.wrap{max-width:1180px;margin:0 auto;padding-inline:24px}
header.bar{background:var(--grain),var(--bar);color:var(--bar-text);box-shadow:inset 0 -6px 0 var(--bar),inset 0 -7px 0 rgb(241 233 215 / .35)}
header.bar .wrap{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 20px;padding-block:18px}
.mark{font-weight:800;font-size:26px;letter-spacing:-0.03em}
.mark i{font-style:normal;color:var(--bar-accent)}
.assignment{font-size:17px;font-weight:600}
.counts{color:var(--bar-muted);font-variant-numeric:tabular-nums}
.skipped{flex-basis:100%;color:var(--bar-accent);font-size:14px}
.lede{padding-block:20px 4px;color:var(--muted);max-width:75ch}
.lede strong{color:var(--text)}
details.legend summary{cursor:pointer;color:var(--accent)}
details.legend p{margin:6px 0 0}
nav.tabs{display:flex;gap:24px;border-bottom:1px solid var(--rule);margin-top:16px}
nav.tabs a{padding:10px 0;text-decoration:none;color:var(--muted);font-weight:600;border-bottom:2px solid transparent}
nav.tabs a:hover{color:var(--text)}
nav.tabs a span{font-variant-numeric:tabular-nums;font-weight:400}
.toolbar{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--rule)}
.toolbar .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding-block:12px}
.toolbar input[type=search],.toolbar select{font:inherit;color:var(--text);background:var(--raised);border:1px solid var(--rule);border-radius:6px;padding:7px 10px}
.toolbar input[type=search]{width:min(260px,100%)}
.toolbar label{display:flex;align-items:center;gap:8px;color:var(--muted)}
.progress{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px;margin:0}
section{padding-block:28px 8px}
h2{font-size:19px;margin:0 0 4px}
h2 + p,.note{color:var(--muted);margin:0 0 16px;max-width:75ch}
.cols{display:grid;grid-template-columns:40px 92px minmax(0,1fr) minmax(0,1.4fr) 120px;gap:0 16px;align-items:center}
.head{color:var(--muted);font-size:13px;padding:0 0 8px;border-bottom:1px solid var(--rule)}
.pair{border-bottom:1px solid var(--rule)}
.pair > .cols{padding-block:12px}
.score{font-variant-numeric:tabular-nums;font-weight:700;font-size:17px;display:flex;align-items:center;gap:10px}
.score i{display:block;height:4px;width:var(--w);max-width:48px;background:var(--vermilion);border-radius:2px}
.who{font-weight:600;overflow-wrap:anywhere}
.who span{color:var(--muted);font-weight:400}
.old{display:block;font-size:13px;color:var(--muted);font-weight:400}
.tags{color:var(--muted)}
button{font:inherit;color:var(--text);background:var(--raised);border:1px solid var(--rule);border-radius:6px;padding:6px 12px;cursor:pointer}
button:hover{border-color:var(--muted)}
.open{justify-self:end}
.pair.done > .cols .who,.pair.done > .cols .score{color:var(--muted);font-weight:400}
.pair.done > .cols .score i{background:var(--rule)}
.evidence{padding:4px 0 24px 56px}
.evidence h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 10px}
.evidence ul.why{margin:8px 0 0;padding-left:18px}
.ab{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}
.ab .name{font-weight:600;border-bottom:1px solid var(--rule);padding-bottom:4px}
.ab figure{margin:0}
.ab img{display:block;width:100%;max-width:420px;height:auto;border:1px solid var(--rule);background:#fff}
.ab figcaption,.small{font-size:13px;color:var(--muted)}
.ab .quote{margin:0;padding:8px 0;border-bottom:1px dashed var(--rule)}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}
dl.meta dt{color:var(--muted)}
dl.meta dd{margin:0;overflow-wrap:anywhere}
.flags{margin:6px 0 0;padding-left:18px}
.actions{margin-top:20px}
.empty{padding:28px 0;color:var(--muted)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;vertical-align:top;padding:10px 16px 10px 0;border-bottom:1px solid var(--rule)}
th{color:var(--muted);font-weight:600;font-size:13px}
td.num{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
tr.over td.num{color:var(--accent)}
td img{max-height:96px;border:1px solid var(--rule)}
.unknown{color:var(--muted)}
.nowrap{white-space:nowrap}
.scroll{overflow-x:auto}
pre{background:var(--raised);border:1px solid var(--rule);border-radius:6px;padding:12px;overflow-x:auto}
.chart{display:block;width:100%;max-width:720px;height:auto;overflow:visible;margin-top:8px}
.chart text{font-size:13px;fill:var(--muted)}
.chart .num{font-variant-numeric:tabular-nums}
.chart .grid{stroke:var(--rule)}
.edge{cursor:pointer}
.edge path{fill:none;stroke:var(--vermilion);stroke-linecap:round}
.edge.old path{stroke-dasharray:4 5}
.edge path.hit{stroke:transparent;stroke-width:14;stroke-dasharray:none}
.edge:hover path:not(.hit){stroke-opacity:1}
.edge.done path:not(.hit){stroke:var(--rule);stroke-opacity:1}
.node circle{fill:var(--text);stroke:var(--bg);stroke-width:2}
.node text{fill:var(--text)}
.node.old circle{fill:var(--bg);stroke:var(--muted);stroke-width:1.5}
.map.focus .edge:not(.hot),.map.focus .node:not(.hot){opacity:.15}
.zone{fill:var(--accent-soft);fill-opacity:.7}
.dot{fill:var(--text);stroke:var(--bg);stroke-width:2}
.dot.hot{fill:var(--vermilion)}
.chart .label{fill:var(--text);font-weight:600}
.figure{margin:0 0 24px}
.figure figcaption{font-size:13px;color:var(--muted);max-width:75ch}
.pair{scroll-margin-top:72px}
#tip{position:fixed;z-index:5;pointer-events:none;background:var(--bar);color:var(--bar-text);font-size:13px;padding:4px 8px;border-radius:6px;white-space:nowrap}
footer{color:var(--muted);font-size:13px;padding-block:32px 48px}
@media (max-width:720px){
.wrap{padding-inline:16px}
.cols{grid-template-columns:28px 52px minmax(0,1fr) auto;gap:0 10px}
.score i{display:none}
.open{padding:6px 10px}
.cols .tags{grid-column:3/5;grid-row:2;font-size:14px}
.head .tags{display:none}
.evidence{padding-left:0}
.ab{grid-template-columns:1fr}
.ab .name{display:none}
#students table,#students tbody,#students tr,#students td{display:block}
#students thead{display:none}
#students tr{padding:12px 0;border-bottom:1px solid var(--rule)}
#students td{border:0;padding:2px 0}
#students td[data-label]::before{content:attr(data-label) ": ";color:var(--muted)}
.ab [data-name]::before{content:attr(data-name);display:block;font-size:13px;font-weight:600;color:var(--muted);margin-top:8px}
.progress{margin-left:0}
.map text{font-size:26px}
.writing{min-width:600px}
}
@media print{
:root{--bg:#fff;--raised:#fff;--rule:#ccc;--text:#000;--muted:#444;--accent:#000;color-scheme:light}
header.bar{background:#fff;color:#000;border-bottom:2px solid #000;box-shadow:none}
header.bar .counts{color:#444}
#tip,.toolbar,nav.tabs,.open,.actions,.pair > .cols > label,details.legend{display:none}
.pair{break-inside:avoid}
.cols{grid-template-columns:72px minmax(0,1fr) minmax(0,1.4fr)}
.head > span:first-child,.head > span:last-child{display:none}
.skipped{color:#000}
.chart{break-inside:avoid}
body.print-one main section:not(#pairs),body.print-one #pairs > p,body.print-one .lede .setaside,body.print-one .head,body.print-one .pair:not(.print-target),body.print-one footer{display:none}
.evidence{padding-left:0}
}`;

const JS = `
(() => {
  const KEY = "maat-checked:" + document.title;
  let checked = new Set();
  try { checked = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (e) {}
  const pairs = [...document.querySelectorAll(".pair")];
  const $ = s => document.querySelector(s);
  const edges = [...document.querySelectorAll(".edge")], tip = $("#tip"), map = $(".map");
  document.addEventListener("pointerover", e => { const t = e.target.closest("[data-tip]"); tip.hidden = !t; if (t) tip.textContent = t.dataset.tip; });
  document.addEventListener("pointermove", e => { if (tip.hidden) return;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 18) + "px"; });
  for (const n of document.querySelectorAll(".node")) {
    n.addEventListener("pointerenter", () => { const w = n.dataset.who; map.classList.add("focus"); n.classList.add("hot");
      for (const g of edges) if (g.dataset.a === w || g.dataset.b === w) { g.classList.add("hot");
        for (const m of map.querySelectorAll(".node")) if (m.dataset.who === g.dataset.a || m.dataset.who === g.dataset.b) m.classList.add("hot"); } });
    n.addEventListener("pointerleave", () => { map.classList.remove("focus"); for (const h of map.querySelectorAll(".hot")) h.classList.remove("hot"); });
  }
  for (const g of edges) g.addEventListener("click", () => {
    const p = pairs.find(x => x.dataset.key === g.dataset.key);
    if (p.hidden) $("#clear").click();
    p.querySelector("details").open = true; p.scrollIntoView({ block: "start" });
  });
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...checked])); } catch (e) {} };
  function apply() {
    const q = $("#q").value.trim().toLowerCase(), kind = $("#kind").value, min = +$("#min").value, hide = $("#hide").checked;
    let shown = 0;
    for (const p of pairs) {
      const done = checked.has(p.dataset.key);
      p.classList.toggle("done", done);
      p.querySelector("input[type=checkbox]").checked = done;
      const ok = (!q || p.dataset.who.includes(q)) && (!kind || p.dataset.kinds.split("|").includes(kind)) && +p.dataset.score >= min && !(hide && done);
      p.hidden = !ok;
      shown += ok;
    }
    for (const g of edges) g.classList.toggle("done", checked.has(g.dataset.key));
    for (const r of document.querySelectorAll("#students tbody tr")) r.hidden = !!q && !r.dataset.who.includes(q);
    $("#progress").textContent = checked.size + " of " + pairs.length + " checked";
    $("#shown").textContent = shown === pairs.length ? "" : "Showing " + shown + " of " + pairs.length + " pairs.";
    $("#none").hidden = shown > 0 || !pairs.length;
  }
  for (const p of pairs) p.querySelector("input[type=checkbox]").addEventListener("change", e => {
    e.target.checked ? checked.add(p.dataset.key) : checked.delete(p.dataset.key);
    save(); apply();
  });
  for (const id of ["q", "kind", "min", "hide"]) $("#" + id).addEventListener("input", apply);
  $("#clear").addEventListener("click", () => { $("#q").value = ""; $("#kind").value = ""; $("#min").value = "0"; $("#hide").checked = false; apply(); });
  for (const b of document.querySelectorAll(".pair .print")) b.addEventListener("click", () => {
    const p = b.closest(".pair");
    p.querySelector("details").open = true;
    p.classList.add("print-target"); document.body.classList.add("print-one");
    window.print();
  });
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("print-one");
    for (const p of pairs) p.classList.remove("print-target");
  });
  for (const d of document.querySelectorAll(".pair details")) d.addEventListener("toggle", () => {
    d.closest(".pair").querySelector(".open").textContent = d.open ? "Hide evidence" : "Evidence";
  });
  for (const b of document.querySelectorAll(".pair .open")) b.addEventListener("click", () => { const d = b.closest(".pair").querySelector("details"); d.open = !d.open; });
  apply();
})();`;

// ---------- charts: inline SVG, no library ----------

// students on a circle, one curve per pair; walking the strongest links first puts connected students side by side
// ponytail: circle layout, labels crowd past ~60 linked students; force layout if classes get that big
function mapChart(pairs, old) {
  const adj = new Map();
  for (const p of pairs) for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) (adj.get(x) || adj.set(x, []).get(x)).push([p.score, y]);
  const order = [], seen = new Set();
  const walk = s => { if (seen.has(s)) return; seen.add(s); order.push(s); for (const [, t] of adj.get(s).sort((x, y) => y[0] - x[0])) walk(t); };
  pairs.forEach(p => walk(p.a));
  if (order.length < 3) return "";
  const W = 720, H = 480, cx = W / 2, cy = H / 2, R = 200, at = new Map();
  order.forEach((s, i) => { const t = 2 * Math.PI * i / order.length - Math.PI / 2; at.set(s, [Math.cos(t), Math.sin(t)]); });
  const xy = (s, r = R) => at.get(s).map((v, i) => +((i ? cy : cx) + v * r).toFixed(1));
  const edges = [...pairs].reverse().map(p => {
    const [ax, ay] = xy(p.a), [bx, by] = xy(p.b), qx = cx + ((ax + bx) / 2 - cx) * 0.3, qy = cy + ((ay + by) / 2 - cy) * 0.3;
    const d = `M${ax} ${ay}Q${qx.toFixed(1)} ${qy.toFixed(1)} ${bx} ${by}`;
    return `<g class="edge${p.old ? " old" : ""}" data-key="${esc(`${p.a} | ${p.b}`)}" data-a="${esc(p.a)}" data-b="${esc(p.b)}" data-tip="${esc(`${p.a} and ${p.b} · score ${p.score}`)}">`
      + `<path d="${d}" stroke-width="${Math.min(5, 1 + p.score / 30).toFixed(1)}" stroke-opacity="${Math.min(1, 0.35 + p.score / 160).toFixed(2)}"/><path class="hit" d="${d}"/></g>`;
  }).join("");
  const nodes = order.map(s => {
    const [x, y] = xy(s), [lx, ly] = xy(s, R + 14), c = at.get(s)[0], n = adj.get(s).length;
    const anchor = c > 0.15 ? "start" : c < -0.15 ? "end" : "middle", dy = at.get(s)[1] > 0.9 ? 12 : at.get(s)[1] < -0.9 ? -4 : 4;
    const name = s.length > 22 ? s.slice(0, 21) + "…" : s;
    return `<g class="node${old.has(s) ? " old" : ""}" data-who="${esc(s)}" data-tip="${esc(`${s}${old.has(s) ? " (earlier year)" : ""} · ${plural(n, "link")}`)}">`
      + `<circle cx="${x}" cy="${y}" r="5"/><text x="${lx}" y="${ly + dy}" text-anchor="${anchor}">${esc(name)}</text></g>`;
  }).join("");
  return `<svg class="chart map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${order.length} students linked by ${pairs.length} pairs; the pairs list below has the same data">${edges}${nodes}</svg>`;
}

// words against editing time per document; the shaded corner is the "pasted?" flag
function writingChart(current, data) {
  const pts = sorted(current).map(s => [s, Number(data.get(s).meta.TotalTime), Number(data.get(s).meta.Words)]).filter(([, m, w]) => m >= 0 && w >= 0);
  if (pts.length < 3) return "";
  const W = 720, H = 320, l = 56, r = 16, t = 36, b = 44;
  const mMax = Math.max(PASTE_MINUTES * 4, ...pts.map(p => p[1])), wMax = Math.max(PASTE_WORDS * 2, ...pts.map(p => p[2]));
  const wStep = [100, 200, 500, 1000, 2000, 5000, 10000].find(s => wMax / s <= 5) || 20000, wTop = Math.ceil(wMax / wStep) * wStep;
  const sx = m => +(l + Math.sqrt(m / mMax) * (W - l - r)).toFixed(1), sy = w => +(H - b - w / wTop * (H - t - b)).toFixed(1);   // sqrt x: the 10-minute corner stays visible
  const xt = [0, 10, 30, 60, 120, 240, 480, 960, 1920, 3840, 7680].filter(m => m <= mMax);
  const yt = Array.from({ length: wTop / wStep + 1 }, (_, i) => i * wStep);
  const pasted = ([, m, w]) => w >= PASTE_WORDS && m <= PASTE_MINUTES;
  let g = `<rect class="zone" x="${l}" y="${t}" width="${(sx(PASTE_MINUTES) - l).toFixed(1)}" height="${(sy(PASTE_WORDS) - t).toFixed(1)}"/>`
    + `<text x="${sx(PASTE_MINUTES) + 6}" y="${t + 12}">pasted? ${PASTE_WORDS}+ words in ${PASTE_MINUTES} min or less</text>`;
  g += yt.map(w => `<line class="grid" x1="${l}" x2="${W - r}" y1="${sy(w)}" y2="${sy(w)}"/><text class="num" x="${l - 8}" y="${sy(w) + 4}" text-anchor="end">${w}</text>`).join("");
  g += xt.map(m => `<text class="num" x="${sx(m)}" y="${H - b + 18}" text-anchor="middle">${m}</text>`).join("");
  g += `<text x="${l}" y="${H - 4}">Editing time in minutes (square-root scale)</text><text x="${l - 8}" y="${t - 18}" text-anchor="end">Words</text>`;
  g += pts.map(p => `<circle class="dot${pasted(p) ? " hot" : ""}" cx="${sx(p[1])}" cy="${sy(p[2])}" r="5" data-tip="${esc(`${p[0]} · ${p[2]} words in ${p[1]} min`)}"/>`
    + (pasted(p) ? `<text class="label" x="${sx(p[1]) + 8}" y="${sy(p[2]) + 4}">${esc(p[0])}</text>` : "")).join("");
  return `<svg class="chart writing" viewBox="0 0 ${W} ${H}" role="img" aria-label="Words against editing time for ${pts.length} documents; the students table below has the same data">${g}</svg>`;
}

export async function report(res, out, title, keepDir = null, jar = null) {
  const { data, current } = res;
  const assignment = title.replace(/^Maat fraud check – /, "");
  const pad = n => String(n).padStart(2, "0");
  const when = t => t ? `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : "";
  const val = v => v ? esc(v) : '<span class="unknown">unknown</span>';
  const edit = m => "TotalTime" in m ? `${m.TotalTime} min / ${m.Words ?? "?"} words` : "";
  const metaOf = s => {
    const d = data.get(s), m = d.meta;
    return `<div><dl class="meta"><dt>Made with</dt><dd>${val(generator(m))}</dd><dt>Last modified by</dt><dd>${val(m.lastModifiedBy || m.Author || "")}</dd>`
      + `<dt>Created (UTC)</dt><dd>${val(when(m._time))}</dd><dt>Editing time</dt><dd>${val(edit(m))}</dd>`
      + `<dt>Files</dt><dd class="mono">${d.files.map(esc).join("<br>") || val("")}</dd></dl>`
      + (d.flags.length ? `<ul class="flags">${d.flags.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : "") + "</div>";
  };
  const ab = (a, b, rows) => `<div class="ab"><div class="name">${esc(a)}</div><div class="name">${esc(b)}</div>`
    + rows.map(([x, y]) => `<div data-name="${esc(a)}">${x}</div><div data-name="${esc(b)}">${y}</div>`).join("") + "</div>";
  const allKinds = new Set();

  const rows = [];
  for (const p of res.pairs) {
    const kinds = kindsOf(p);
    kinds.forEach(k => allKinds.add(k));
    let ev = `<ul class="why">${p.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>`;
    if (p.imgs.length) {
      const cells = [];
      for (const [x, y, w] of p.imgs.slice(0, 6))
        cells.push([`<figure><img src="${await thumb(x, 480)}" alt="Image from ${esc(p.a)}"><figcaption>${esc(w)}</figcaption></figure>`,
          `<figure><img src="${await thumb(y, 480)}" alt="Matching image from ${esc(p.b)}"></figure>`]);
      ev += `<h3>Matching images</h3>${ab(p.a, p.b, cells)}`;
    }
    if (p.shared.length)
      ev += `<h3>Shared sentences</h3>${ab(p.a, p.b, p.shared.slice(0, 12).map(([x, y]) => [`<p class="quote">${esc(x)}</p>`, `<p class="quote">${esc(y)}</p>`]))}`;
    if (p.para.length)
      ev += `<h3>Same content, other words</h3>${ab(p.a, p.b, p.para.slice(0, 8).map(([x, y]) => [`<p class="quote">${esc(x)}</p>`, `<p class="quote">${esc(y)}</p>`]))}`;
    ev += `<h3>The two submissions</h3>${ab(p.a, p.b, [[metaOf(p.a), data.has(p.b) ? metaOf(p.b) : ""]])}`;
    ev += `<div class="actions"><button type="button" class="print">Print this pair</button></div>`;
    const key = `${p.a} | ${p.b}`;
    rows.push(`<article class="pair" data-key="${esc(key)}" data-who="${esc((p.a + " " + p.b).toLowerCase())}" data-kinds="${esc(kinds.join("|"))}" data-score="${p.score}">
<div class="cols"><label><input type="checkbox" aria-label="Checked: ${esc(p.a)} and ${esc(p.b)}"></label>
<span class="score">${p.score}<i style="--w:${Math.min(48, Math.round(p.score * 0.48))}px"></i></span>
<span class="who">${esc(p.a)} <span>and</span> ${esc(p.b)}${p.old ? '<span class="old">earlier year</span>' : ""}</span>
<span class="tags">${esc(kinds.join(" · "))}</span>
<button type="button" class="open" aria-label="Evidence for ${esc(p.a)} and ${esc(p.b)}">Evidence</button></div>
<details><summary hidden>Evidence</summary><div class="evidence">${ev}</div></details></article>`);
  }

  let clRows = "";
  for (const c of res.clusters)
    clRows += `<tr><td>${c.kind === "image" ? "Image" : "Sentence"}</td><td>${esc(c.students.join(", "))}</td><td>`
      + (c.kind === "image" ? `<img src="${await thumb(c.example)}" alt="Image shared by ${esc(c.students.join(", "))}">` : esc(c.example)) + "</td></tr>";
  const codeRows = res.codeTop.map(([s, a, b, f1, f2]) =>
    `<tr class="${s >= res.dolosMin ? "over" : ""}"><td class="num">${pct(s)}</td><td>${esc(a)} and ${esc(b)}</td><td class="mono">${esc(f1)} ~ ${esc(f2)}</td></tr>`).join("");
  const studentRows = sorted(current).map(s => {
    const d = data.get(s), m = d.meta;
    return `<tr data-who="${esc(s.toLowerCase())}"><td><b>${esc(s)}</b></td><td data-label="Made with">${val(generator(m))}</td>`
      + `<td data-label="Last modified by">${val(m.lastModifiedBy || m.Author || "")}</td>`
      + `<td class="nowrap" data-label="Created (UTC)">${val(when(m._time))}</td><td class="nowrap" data-label="Editing time">${val(edit(m))}</td>`
      + `<td>${d.flags.map(esc).join("<br>")}</td></tr>`;
  }).join("");
  let viewers = "";
  if (keepDir) {
    const lines = [];
    if (fs.existsSync(path.join(keepDir, "jplag.jplag"))) lines.push(`java -jar "${jar}" -M VIEW "${path.join(keepDir, "jplag.jplag")}"`);
    lines.push(...sorted(fs.readdirSync(keepDir).filter(f => f.startsWith("dolos-"))).map(f => `dolos serve "${path.join(keepDir, f)}"`));
    if (lines.length) viewers = `<section><h2>Open the details in JPlag and Dolos</h2><p>Both tools show their comparisons side by side:</p><pre><code>${esc(lines.join("\n"))}</code></pre></section>`;
  }
  const mapSvg = mapChart(res.pairs, res.old), writeSvg = writingChart(current, data);
  const nOld = res.old.size, flagged = sorted(current).filter(s => data.get(s).flags.length).length;
  const kindOpts = [...allKinds].map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<header class="bar"><div class="wrap"><span class="mark">maat<i>.</i></span><span class="assignment">${esc(assignment)}</span>
<span class="counts">${plural(current.size, "student")}${nOld ? ` · ${nOld} from earlier years` : ""} · ${plural(res.pairs.length, "pair")} · ${plural(res.clusters.length, "cluster")} · ${flagged} with notes</span>
${res.skipped.length ? `<span class="skipped">Not checked: ${esc(res.skipped.join(", "))}</span>` : ""}</div></header>
<main>
<div class="wrap">
<div class="lede"><p><strong>These are signals, not proof.</strong> Always check the originals, and talk to the student before drawing any conclusion.
<span class="setaside">What appears in ${res.commonMin} or more students counts as course material and was set aside: ${plural(res.common.images, "image")} and ${plural(res.common.sentences, "sentence")}.</span></p>
<details class="legend"><summary>How the score is built</summary><p>Matching image 50, same online document 40, 3+ identical random IDs 40, shared sentence 5 (max 30),
paraphrased sentence 4 (max 20), JPlag 50 × similarity, Dolos 60 × similarity (above the class threshold), same suspicious generator 15 (+10 within ${NEAR_MINUTES} minutes).</p></details></div>
<nav class="tabs" aria-label="Sections">${mapSvg ? `<a href="#map">Map</a>` : ""}<a href="#pairs">Pairs <span>${res.pairs.length}</span></a><a href="#clusters">Clusters <span>${res.clusters.length}</span></a>${codeRows ? `<a href="#code">Code <span>${res.codeTop.length}</span></a>` : ""}<a href="#students">Students <span>${current.size}</span></a></nav>
</div>
<div class="toolbar"><div class="wrap">
<input type="search" id="q" placeholder="Find a student" aria-label="Find a student">
<select id="kind" aria-label="Signal"><option value="">All signals</option>${kindOpts}</select>
<select id="min" aria-label="Minimum score"><option value="0">Any score</option><option value="20">Score 20+</option><option value="40">Score 40+</option><option value="60">Score 60+</option></select>
<label><input type="checkbox" id="hide"> Hide checked</label>
<span class="progress" id="progress" aria-live="polite"></span>
</div></div>
<div class="wrap">
${mapSvg ? `<section id="map"><h2>Who connects to whom</h2><p>Every pair with a signal is a curve; thicker and redder means a higher score. Look for one student linked to many others, or a closed group. Hover a name to isolate it, click a curve to open the pair.</p>${mapSvg}</section>` : ""}
<section id="pairs"><h2>Pairs to look at</h2><p>Strongest first. Open a pair to compare the two submissions side by side; tick it off once you have looked. <span id="shown"></span></p>
${res.pairs.length ? `<div class="cols head"><span></span><span>Score</span><span>Students</span><span class="tags">Signals</span><span></span></div>${rows.join("\n")}` : `<p class="empty">No pairs with a signal.</p>`}
<div class="empty" id="none" hidden>No pairs match these filters. <button type="button" id="clear">Clear filters</button></div></section>
<section id="clusters"><h2>Clusters</h2><p>The same image or sentence in three or more students.</p>
${clRows ? `<div class="scroll"><table><thead><tr><th>What</th><th>Students</th><th>Example</th></tr></thead><tbody>${clRows}</tbody></table></div>` : `<p class="empty">No clusters.</p>`}</section>
${codeRows ? `<section id="code"><h2>Code</h2><p>Dolos similarity across each pair's whole project. Pairs above the class threshold of ${pct(res.dolosMin)} (mean plus two standard deviations, at least 50%) count towards the score.</p>
<div class="scroll"><table><thead><tr><th>Similar</th><th>Students</th><th>Most similar files</th></tr></thead><tbody>${codeRows}</tbody></table></div></section>` : ""}
<section id="students"><h2>Students</h2><p>What the files say about how they were made. Notes are worth a look on their own, not proof.</p>
${writeSvg ? `<figure class="figure"><div class="scroll">${writeSvg}</div><figcaption>Words against editing time, as Word and PowerPoint record them. A lot of text in very little editing time suggests it was pasted in from somewhere else.</figcaption></figure>` : ""}
<div class="scroll"><table><thead><tr><th>Student</th><th>Made with</th><th>Last modified by</th><th>Created (UTC)</th><th>Editing time</th><th>Notes</th></tr></thead><tbody>${studentRows}</tbody></table></div></section>
${viewers}
</div></main>
<footer><div class="wrap">Made by maat on ${new Date().toISOString().slice(0, 10)}. This report contains student names and work: keep it on your own computer.</div></footer>
<div id="tip" role="tooltip" hidden></div>
<script>${JS}</script>
</body></html>`;
  fs.writeFileSync(out, page);
}

export function toJson(res, out) {
  const { data } = res;
  const j = {
    students: Object.fromEntries(sorted(res.current).map(s => {
      const d = data.get(s);
      return [s, { flags: d.flags, generator: generator(d.meta), tool: toolFamily(d.meta), files: d.files, links: d.links }];
    })),
    pairs: res.pairs.map(p => ({ a: p.a, b: p.b, score: p.score, earlier_year: p.old, reasons: p.reasons,
      images: p.imgs.length, shared: p.shared.map(([x]) => x), paraphrased: p.para })),
    clusters: res.clusters.map(c => ({ kind: c.kind, students: c.students, example: c.kind === "sentence" ? c.example : null })),
    code: res.codeTop.map(([similarity, a, b, f1, f2]) => ({ similarity, a, b, files: [f1, f2] })),
    dolos_threshold: res.dolosMin, common: res.common, skipped: res.skipped,
  };
  fs.writeFileSync(out, JSON.stringify(j, null, 1));
}


const HELP = `Maat, a fraud checker for student submissions.

Usage: maat <folder> [options]

  <folder>                 folder with submissions (Canvas names: <student>_<id>_<id>_<file>)
  --template <file>        blank assignment/template: its text and images are ignored
  --old <folder>           folder with submissions from an earlier year (repeatable)
  --ignore-author <name>   author name that is expected, e.g. the teacher (repeatable)
  --ignore-image <file>    image to ignore, e.g. a school logo (repeatable)
  --exclude <pattern>      file name pattern to skip, e.g. '*_feedback.txt' (repeatable)
  --jplag <jar>            path to jplag-*.jar (default: newest ~/tools/jplag/jplag-*.jar)
  --history <file>         each student's history across assignments (default ~/.maat/history.json)
  --no-history             don't read or update the history
  --no-ocr                 no text recognition in images
  --no-embed               no paraphrase detection (embeddings)
  -o, --output <file>      report (default maat.html; also writes .json and _files/)
`;

export async function main(argv = process.argv.slice(2)) {
  const many = { type: "string", multiple: true, default: [] };
  let a, positionals;
  try {
    ({ values: a, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      template: { type: "string" }, old: many, "ignore-author": many, "ignore-image": many, exclude: many,
      jplag: { type: "string" }, history: { type: "string", default: path.join(os.homedir(), ".maat", "history.json") },
      "no-history": { type: "boolean" }, "no-ocr": { type: "boolean" }, "no-embed": { type: "boolean" },
      output: { type: "string", short: "o", default: "maat.html" }, help: { type: "boolean", short: "h" },
    } }));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (a.help || positionals.length !== 1) {
    (a.help ? console.log : console.error)(HELP);
    process.exit(a.help ? 0 : 2);
  }
  const folder = positionals[0];
  let jar = a.jplag;
  if (!jar) {
    const dir = path.join(os.homedir(), "tools", "jplag");
    const jars = fs.existsSync(dir) ? sorted(fs.readdirSync(dir).filter(f => /^jplag-.*\.jar$/.test(f))) : [];
    jar = jars.length ? path.join(dir, jars.at(-1)) : null;
  }
  log(`JPlag (text): ${jar || "not found"} | Dolos (code): ${which("dolos") || "not found"} | `
    + `OCR: ${a["no-ocr"] ? "off" : which("tesseract") || "not found"}`);
  if (!which("pdftotext")) log("poppler (pdftotext) not found: PDFs are skipped");

  let history = null;
  if (!a["no-history"]) history = fs.existsSync(a.history) ? JSON.parse(fs.readFileSync(a.history, "utf8")) : {};
  const base = a.output.slice(0, a.output.length - path.extname(a.output).length);
  const keepDir = base + "_files";
  fs.mkdirSync(keepDir, { recursive: true });

  const res = await analyse(folder, { template: a.template, jar, ignore: a["ignore-author"], ignoreImages: a["ignore-image"],
    old: a.old, ocr: !a["no-ocr"], embed: !a["no-embed"], history, keepDir, exclude: a.exclude });
  await report(res, a.output, "Maat fraud check – " + path.basename(path.resolve(folder)), keepDir, jar);
  toJson(res, base + ".json");
  if (history) {
    fs.mkdirSync(path.dirname(a.history), { recursive: true });
    fs.writeFileSync(a.history, JSON.stringify(history, null, 1));
  }

  for (const p of res.pairs.slice(0, 10)) console.log(`${String(p.score).padStart(4)}  ${p.a} <-> ${p.b}: ${why(p)}`);
  for (const c of res.clusters.slice(0, 5)) console.log(`cluster (${c.kind}): ${c.students.join(", ")}`);
  const flagged = sorted(res.current).filter(s => res.data.get(s).flags.length);
  console.log(`${flagged.length} students with a notable finding (see report)`);
  if (res.codeTop.length) {
    const [s, x, y] = res.codeTop[0];
    console.log(`code: highest project similarity ${pct(s)} (${x} <-> ${y}), class threshold ${pct(res.dolosMin)}`);
  }
  console.log(`report: ${path.resolve(a.output)}`);
}

if (import.meta.main) await main();
