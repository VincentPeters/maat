// Self-test with synthetic submissions: npm test
//
// Builds a fake class of 10 students + 1 from an earlier year and checks that every signal
// is found, and that template material and the 'clean' students produce nothing.
// JPlag, Dolos and embeddings are off, so the test runs the same everywhere; OCR is
// checked if Tesseract is installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import * as maat from "./maat.js";


// ---------- helpers ----------

const COLORS = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0],
  orange: [255, 165, 0], purple: [128, 0, 128] };

// shapes: [kind ("r" rectangle, "e" ellipse), [x0, y0, x1, y1], colour], boxes inclusive like Pillow
function png(shapes, { size = [400, 300], fmt = "png", resize } = {}) {
  const [w, h] = size, px = Buffer.alloc(w * h * 3, 255);
  for (const [kind, [x0, y0, x1, y1], color] of shapes)
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
        const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
        if (kind === "e" && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        px.set(COLORS[color], (y * w + x) * 3);
      }
  let im = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  if (resize) im = im.resize(resize[0], resize[1], { fit: "fill" });
  return im.toFormat(fmt).toBuffer();
}

const DIAGRAM = ["blue", "green", "orange", "purple"].map((c, i) => ["r", [60, 20 + i * 70, 340, 70 + i * 70], c]);
const TEMPLATE_IMG = [["r", [0, 0, 400, 60], "black"], ["e", [150, 100, 250, 200], "red"]];

// minimal docx: only what maat reads
function docx(file, paragraphs, { images = [], links = [], creator = "Student", modifiedBy = "Student",
  created = "2026-10-20T10:00:00Z", app = "Microsoft Office Word", minutes = 120, words = 400, rsids = [] } = {}) {
  const rels = links.map(([h], i) => `<Relationship Id="rIdL${i}" Type="hyperlink" Target="${h}" TargetMode="External"/>`).join("");
  let body = paragraphs.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  body += links.map(([, t], i) => `<w:p><w:hyperlink r:id="rIdL${i}"><w:r><w:t>${t}</w:t></w:r></w:hyperlink></w:p>`).join("");
  const z = {
    "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:r="r"><w:body>${body}</w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8(`<Relationships>${rels}</Relationships>`),
    "docProps/core.xml": strToU8(`<cp:coreProperties><dc:creator>${creator}</dc:creator>`
      + `<cp:lastModifiedBy>${modifiedBy}</cp:lastModifiedBy><dcterms:created>${created}</dcterms:created></cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<Properties><Application>${app}</Application><TotalTime>${minutes}</TotalTime><Words>${words}</Words></Properties>`),
    "word/settings.xml": strToU8(`<w:settings><w:rsids>${[TEMPLATE_RSID, ...rsids].map(r => `<w:rsid w:val="${r}"/>`).join("")}</w:rsids></w:settings>`),
  };
  images.forEach((data, i) => { z[`word/media/image${i}.png`] = data; });
  fs.writeFileSync(file, zipSync(z));
}

const TEMPLATE_RSID = "00A3F2B7";
const TEMPLATE_TXT = "Step 1 - Purpose of the application: what is the main goal of the application you are analysing?";
const SHARED_Q = ["The user opens the app and immediately sees all notifications from the past week.",
  "Every notification shows the time, the sensor and the measured value in a clear table.",
  "When a value is too high the row turns red so that the problem stands out."];

const cap = s => s[0].toUpperCase() + s.slice(1);
const unique = (name, n = 3) => Array.from({ length: n }, (_, i) =>
  `${cap(name)} describes topic number ${i} here in their own words about ${name}${i}land and ${name}${i}town.`);

const node = (id, type, name = "", func) => ({ id, type, name, ...(func ? { func } : {}) });
const flow = (file, nodes) => fs.writeFileSync(file, JSON.stringify(nodes));

const OWN_FUNC = 'const s = msg.req.headers["x-secret"];\nif (s !== env.get("WEBHOOK_SECRET")) {\n  msg.statusCode = 401;\n  return [null, msg];\n}\nreturn [msg, null];';
const LESSON_FUNC = 'let recent = flow.get("recentEventIds") || [];\nconst id = msg.req.headers["x-event-id"];\nif (recent.includes(id)) { return [null, msg]; }\nrecent.unshift(id);\nflow.set("recentEventIds", recent.slice(0, 50));\nreturn [msg, null];';

async function build(root) {
  const [sub, old, tmpl] = ["submissions", "lastyear", "template"].map(x => path.join(root, x));
  for (const d of [sub, old, tmpl]) fs.mkdirSync(d);
  const tImg = await png(TEMPLATE_IMG);
  docx(path.join(tmpl, "template.docx"), [TEMPLATE_TXT], { images: [tImg] });
  const common = [TEMPLATE_TXT];
  const anna = ["My smart beehive weighs the honey every night and sends the weight to the beekeeper.",
    "The scale under the hive measures to within ten grams how much honey has been added.",
    "When the weight suddenly drops the beekeeper gets a notification about a possible swarm."];
  const S = n => path.join(sub, `${n}_1_2_report.docx`);
  docx(S("anna"), [...common, ...anna], { images: [await png(DIAGRAM), tImg], links: [["https://miro.com/app/board/uXjVAAAA=/", "my board"]],
    creator: "Anna Peeters", modifiedBy: "Anna Peeters" });
  docx(S("bram"), [...common, ...unique("bram")], { images: [await png(DIAGRAM, { fmt: "jpeg", resize: [800, 600] }), tImg],   // rescaled copy
    links: [["https://www.example.org/sensor?utm_source=chatgpt.com", "source"]],
    creator: "python-docx", modifiedBy: "Bram Jacobs", created: "2026-10-22T20:41:00Z" });
  docx(S("carl"), [...common, ...unique("carl", 1), anna[0].replace("every night", "each night"), anna[1]],
    { images: [tImg], links: [["https://miro.com/app/board/uXjVZZZZ=/", "board"], ["https://docs.google.com/document/d/1aBcD3fGhIjKlMnOpQrStUvWxYz012345/edit", "doc"]],
      creator: "python-docx", modifiedBy: "Someone Else", created: "2026-10-22T21:05:00Z" });
  docx(S("dirk"), [...common, ...unique("dirk")], { images: [tImg], links: [["https://miro.com/app/board/uXjVZZZZ=/", "board"],
    ["https://docs.google.com/document/d/1aBcD3fGhIjKlMnOpQrStUvWxYz012345/edit", "our doc"],
    ["https://petlibro.com/feeder", "www.petsafe.com"]], creator: "Dirk", modifiedBy: "Dirk", minutes: 2, words: 500 });
  for (const n of ["eva", "fien", "gert"]) docx(S(n), [...common, ...unique(n, 2), ...SHARED_Q], { images: [tImg], creator: n, modifiedBy: n,
    rsids: n === "eva" ? [] : ["00C4D19E", "005E7A21", "00B93F04"] });
  for (const n of ["hans", "ines", "jan"]) docx(S(n), [...common, ...unique(n)], { images: [tImg], creator: n, modifiedBy: n });
  docx(path.join(sub, "hans_1_2_feedback.txt"), []);                                       // skipped via exclude
  // Node-RED: dirk imported anna's flow (same ids, same function), bram wrote his by hand,
  // the lesson function in 5 students is course material, jan's export is empty
  const copied = [node("3f9a1c22b7e0d451", "tab"), node("8c41e7a0d29b3f16", "http in"),
    node("b2d07f5e91ac4e38", "function", "Secret check", OWN_FUNC), node("e6a93b1d0f7c2a59", "http response")];
  flow(path.join(sub, "anna_1_3_flows.json"), copied);
  flow(path.join(sub, "dirk_1_3_flows.json"), copied.map(n => ({ ...n, x: (n.x || 0) + 40 })));
  flow(path.join(sub, "bram_1_3_flows.json"), Array.from({ length: 5 }, (_, i) => node(`a5f100000000000${i}`, "function", `f${i}`, "return msg;")));
  ["eva", "fien", "gert", "hans", "ines"].forEach((n, k) =>
    flow(path.join(sub, `${n}_1_3_flows.json`), [node(`${k}1c8e2f09ab7d4${k}6`, "function", "Dedup", LESSON_FUNC)]));
  fs.writeFileSync(path.join(sub, "jan_1_3_flows.json"), "");
  fs.writeFileSync(path.join(sub, "carl_1_4_analysis.ipynb"), JSON.stringify({ metadata: { kernelspec: { language: "python" } }, cells: [
    { cell_type: "markdown", id: "9f1c2ab7", source: ["Carl measured the soil moisture of his balcony plants every hour for a week."] },
    { cell_type: "code", id: "4be07d1e", source: ["import pandas as pd\n", "df = pd.read_csv('moisture.csv')\n", "df.plot()"] },
  ] }));
  docx(path.join(old, "zoe_9_9_report.docx"), [anna[2], "Last year Zoe also wrote some other sentences about her own beehive."],
    { creator: "Zoe", modifiedBy: "Zoe" });
  return [sub, old, path.join(tmpl, "template.docx")];
}


// ---------- unit checks ----------

const big = await png(["blue", "green", "orange", "purple"].map((c, i) => ["r", [60, 22 + i * 70, 340, 72 + i * 70], c]), { fmt: "jpeg", resize: [800, 600] });
const [a, b] = [await maat.signature(await png(DIAGRAM)), await maat.signature(big)];
const c = await maat.signature(await png([["e", [50, 50, 350, 250], "black"]]));
assert.ok(maat.distance(a, b) <= maat.IMG_DIST, String(maat.distance(a, b)));
assert.ok(maat.distance(a, c) > maat.IMG_DIST, String(maat.distance(a, c)));
assert.equal(await maat.signature(await png([], { size: [50, 40] })), null);

const x = maat.sentences("Which features are available depends on the chosen model and the price.");
const y = maat.sentences("Which features are available depends on the chosen model and price.");
const z = maat.sentences("The cat gets its portion of food at fixed times of the day.");
assert.ok(maat.sharedSentences(x, y).length === 1 && !maat.sharedSentences(x, z).length);
assert.deepEqual(maat.sentences("Step 2 – What do you see as a user of the app"), maat.sentences("step 2 - what do you see as a user of the app"));

assert.equal(maat.sharedDoc("https://miro.com/app/board/uXjVEX_oBas=/?share_link_id=1"), "Miro board uXjVEX_oBas=");
assert.equal(maat.sharedDoc("https://docs.google.com/presentation/d/1aBcD3fGhIjKlMnOpQrStUvWxYz012345/edit#slide=2"),
  "Google document 1aBcD3fGhIjKlMnOpQrStUvWxYz012345");
assert.equal(maat.sharedDoc("https://en.wikipedia.org/wiki/Beehive"), null);
assert.ok(maat.randomId("3f9a1c22b7e0d451") && maat.randomId("00C4D19E") && maat.randomId("8c41e7a0.d29b3f"));
assert.ok(!maat.randomId("a5f1000000000002") && !maat.randomId("ms_secret") && !maat.randomId("node-1"));
assert.equal(maat.domain("www.PetSafe.com/x"), "petsafe.com");
let f = maat.linkFlags([["https://a.com/?utm_source=chatgpt.com", "source"],
  ["https://petlibro.com", "www.petsafe.com"], ["https://petsafe.com/x", "petsafe.com"]]);
assert.ok(f.length === 2 && f.some(x => x.includes("AI chat")) && f.some(x => x.includes("petlibro")), String(f));

f = maat.studentFlags("jansenlotte", { creator: "python-docx", lastModifiedBy: "Kim Vos" }, new Set(["the teacher"]));
assert.ok(f.some(s => s.includes("python-docx")) && f.some(s => s.includes("Kim Vos")), String(f));
assert.deepEqual(maat.studentFlags("maesbart", { creator: "The Teacher", lastModifiedBy: "Maes Bart" }, new Set(["the teacher"])), []);
assert.deepEqual(maat.studentFlags("maesbart", { Author: "Course 1 - Assignment 4 template" }, new Set()), []);
assert.equal(maat.toolFamily({ Producer: "Skia/PDF m158 Google Docs Renderer" }), "Google Docs");
assert.equal(maat.toolFamily({}), "unknown");

if (maat.which("tesseract")) {   // OCR: text in a screenshot is read
  const txt = await sharp({ text: { text: "Message ChatGPT   Copy code", dpi: 300 } }).negate().png().toBuffer();
  const shot = await sharp(txt).extend({ top: 60, bottom: 60, left: 20, right: 20, background: "white" }).png().toBuffer();
  assert.ok((await maat.ocr(shot)).toLowerCase().includes("chatgpt"), await maat.ocr(shot));
}


// ---------- full run on the fake class ----------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "maat-test-"));
try {
  const [sub, old, tmpl] = await build(root);
  const hist = { bram: [{ assignment: "earlier", date: "2026-09-01", tool: "Word", names: ["Bram Jacobs"] }] };
  const res = await maat.analyse(sub, { template: tmpl, ignore: ["the teacher"], old: [old], ocr: false, embed: false,
    dolos: false, history: hist, exclude: ["*_feedback.txt"] });
  const key = (a, b) => [a, b].sort().join("\0");
  const P = new Map(res.pairs.map(p => [key(p.a, p.b), p]));
  const why = (a, b) => P.has(key(a, b)) ? maat.why(P.get(key(a, b))) : "";
  const flags = s => res.data.get(s).flags.join(" | ");

  assert.ok(why("anna", "bram").includes("matching image"), why("anna", "bram"));
  assert.ok(why("bram", "carl").includes("both made with python-docx") && why("bram", "carl").includes("24 min apart"), why("bram", "carl"));
  assert.ok(why("anna", "carl").includes("shared sentence"), why("anna", "carl"));
  assert.ok(why("carl", "dirk").includes("same online document (Miro board uXjVZZZZ=, Google document"), why("carl", "dirk"));
  assert.ok(why("fien", "gert").includes("3 identical random IDs") && !why("eva", "fien").includes("random IDs"), why("fien", "gert"));
  assert.ok(why("anna", "lastyear/zoe").startsWith("earlier year:"), why("anna", "lastyear/zoe"));
  assert.ok(res.clusters.some(c => c.kind === "sentence" && c.students.join() === "eva,fien,gert"), JSON.stringify(res.clusters));
  for (const [a, b] of [["hans", "ines"], ["hans", "jan"], ["ines", "jan"], ["anna", "hans"]])
    assert.ok(!P.has(key(a, b)), `${a} ${b}: ${why(a, b)}`);          // template text and image don't count
  assert.deepEqual(res.common, { images: 0, sentences: 0 });          // template already removed via --template
  assert.deepEqual(res.data.get("hans").files, ["hans_1_2_report.docx", "hans_1_3_flows.json"]);   // --exclude works
  assert.ok(why("anna", "dirk").includes("4 identical random IDs"), why("anna", "dirk"));
  assert.ok(flags("bram").includes("not random") && !flags("anna").includes("not random"), flags("bram") + " / " + flags("anna"));
  assert.ok(res.data.get("anna").code.length === 1 && !res.data.get("jan").code.length);   // function code goes to Dolos
  assert.ok(res.data.get("carl").code.length === 1 && res.data.get("carl").text.includes("balcony plants"));   // notebook: code and text
  assert.ok(!maat.handmadeIds(new Set(["3f9a1c22b7e0d451", "8c41e7a0.d29b3f", "b2d07f5e91ac4e38"])));
  assert.ok(maat.handmadeIds(new Set(["ms_tab", "ms_secret", "ms_dedup"])));

  assert.ok(flags("bram").includes("AI chat"), flags("bram"));
  assert.ok(flags("bram").includes("different tool than before: now python-docx"), flags("bram"));
  assert.ok(flags("carl").includes("Someone Else"), flags("carl"));
  assert.ok(flags("dirk").includes("petlibro.com") && flags("dirk").includes("pasted"), flags("dirk"));
  assert.ok(!flags("hans") && !flags("anna"), flags("hans") + " / " + flags("anna"));
  assert.deepEqual(hist.bram.map(h => h.tool), ["Word", "python-docx"]);            // history updated

  // without --template: whatever a large part of the class shares is dropped as course material
  const res2 = await maat.analyse(sub, { ocr: false, embed: false, dolos: false });
  assert.ok(res2.common.images >= 1 && res2.common.sentences >= 1, JSON.stringify(res2.common));
  assert.ok(!res2.pairs.some(p => p.a === "hans" && p.b === "ines"));

  const out = path.join(root, "r.html");
  await maat.report(res, out, "test");
  maat.toJson(res, path.join(root, "r.json"));
  const j = JSON.parse(fs.readFileSync(path.join(root, "r.json"), "utf8"));
  assert.ok(j.pairs.length && j.clusters.length && "bram" in j.students);
  const page = fs.readFileSync(out, "utf8");
  assert.ok(page.includes("class=\"chart map\"") && page.includes("class=\"chart writing\"") && page.includes("Pairs to look at") && page.includes("anna") && page.includes("data:image/jpeg;base64"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("ok");
