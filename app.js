/* ======================================================================
   脚本分镜工具 · 逻辑层
   规则来源：rules.js (window.DEFAULT_RULES)，可在「⚙ 规则库」页修改
   ====================================================================== */

const BUILD = ((document.currentScript && document.currentScript.src.split('?v=')[1]) || 'dev');
const LS_RULES = 'fenjing.rules.v1';
const LS_PRESET = 'fenjing.preset.v1';
const LS_CUSTOM = 'fenjing.custom.v1';   // 本机自定义规则（覆盖服务器版）

let RULES = null;        // 全部预设
let PRESET = localStorage.getItem(LS_PRESET) || '厦门画巢';
let CUR = null;          // 当前预设（已解析继承）
let RULE_SOURCE = '默认';  // 默认 / 本机自定义

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const TAG_RE = /【([^】]+)】/g;          // 全局：用于 replace
const HAS_TAG = /【[^】]+】/;              // 非全局：用于 test（全局正则的 test 会因 lastIndex 抖动）

function deepMerge(base, over) {
  const out = clone(base);
  for (const k in over) {
    const ov = over[k], bv = out[k];
    const bothObj = ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv);
    if (bothObj) out[k] = deepMerge(bv, ov);
    else if (ov !== undefined) out[k] = clone(ov);
  }
  return out;
}
function resolvePreset(name) {
  const p = RULES.presets[name];
  if (!p) throw new Error('预设不存在: ' + name);
  return p.inherit ? deepMerge(resolvePreset(p.inherit), p) : clone(p);
}
function initRules() {
  let data = null, src = '默认';
  const fileVer = String((window.DEFAULT_RULES || {}).version || '0');
  const saved = localStorage.getItem(LS_RULES);
  if (saved) {
    try {
      const s = JSON.parse(saved);
      // 规则包发新版时，自动改用新版（清掉本机旧缓存），并提示
      if (String(s.version || '0') < fileVer) {
        localStorage.removeItem(LS_RULES);
        console.log('规则包已更新到 v' + fileVer + '，本机旧规则已替换');
      } else { data = s; src = '本机自定义'; }
    } catch (e) { data = null; }
  }
  if (!data) data = clone(window.DEFAULT_RULES);
  RULES = data; RULE_SOURCE = src;
  if (!RULES.presets[PRESET]) PRESET = Object.keys(RULES.presets)[0];
  CUR = resolvePreset(PRESET);
  localStorage.setItem(LS_PRESET, PRESET);
  renderPresetSelect();
  renderRulePanels();
  renderVisualEditor();
  $('verBadge').textContent = '规则 v' + (RULES.version || '?') + ' · ' + RULE_SOURCE;
  if ($('ruleVerFoot')) $('ruleVerFoot').textContent = 'v' + (RULES.version || '?') + '（' + RULE_SOURCE + '）';
  if ($('buildVer')) $('buildVer').textContent = BUILD;
  $('rulesPresetName').textContent = PRESET;
  $('rulesJson').value = JSON.stringify(RULES, null, 2);
}
function renderPresetSelect() {
  const sel = $('presetSel');
  sel.innerHTML = '';
  Object.keys(RULES.presets).forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = RULES.presets[k].label || k;
    if (k === PRESET) o.selected = true;
    sel.appendChild(o);
  });
}

/* ---------- 通用判定 ---------- */
function tagSetOf(preset) {
  const s = new Set();
  const groups = preset.fenjing_tags || {};
  Object.values(groups).forEach(arr => arr.forEach(t => s.add(t)));
  return s;
}
function baseTag(t) {                       // 单品*3 / 出境-展示单品 → 单品 / 出境
  return t.replace(/\*\d+$/, '').split('-')[0].trim();
}
function isFenjingTag(t, set) { return set.has(t) || set.has(baseTag(t)); }
function isWhitelisted(text, preset) {
  const wl = preset.whitelist || {};
  if ((wl.exact || []).some(w => text.includes(`【${w}】`) || text.includes(w))) return true;
  if ((wl.contains || []).some(w => text.includes(w))) return true;
  if ((wl.regex || []).some(r => { try { return new RegExp(r).test(text); } catch (e) { return false; } })) return true;
  return false;
}

/* ---------- ① 加分镜 ---------- */
function countHits(line, words) {          // 长词优先，命中后从文本移除，避免重复计数
  let rest = line, n = 0;
  [...words].sort((a, b) => b.length - a.length).forEach(w => {
    if (rest.includes(w)) { n++; rest = rest.split(w).join(' '); }
  });
  return n;
}
function matchTag(line, preset, mode) {
  const R = preset.add_rule || {};
  // 1) 具体款名 → 单品 / 单品*N
  if (R.products) {
    const n = countHits(line, R.products);
    if (n >= 2) return { tag: `单品*${n}`, why: '产品×' + n };
    if (n === 1) return { tag: '单品', why: '产品' };
  }
  // 2) 风格词 → 风格 / 风格*N
  if (R.style_words) {
    const n = countHits(line, R.style_words);
    if (n >= 2) return { tag: `风格*${n}`, why: '风格×' + n };
    if (n === 1) return { tag: '风格', why: '风格' };
  }
  // 3) 规则表（按顺序，先命中先用）
  for (const r of (R.rules || [])) {
    if (new RegExp(r.pat).test(line)) return { tag: pickTag(r.tag, mode), why: r.name || r.tag };
  }
  // 3.5) 纯品类词兜底（沙发/软床/茶几…）
  if (R.product_generic && R.product_generic.some(w => line.includes(w))) return { tag: '单品', why: '品类' };
  // 1.5) 品牌名（如 Minotti / Edra）：单品牌算单品，多品牌按数量算；与款名同行时不重复计数
  if (R.brands) {
    const nb = countHits(line, R.brands);
    if (nb >= 2) return { tag: `单品*${nb}`, why: '品牌×' + nb };
    if (nb === 1) return { tag: '单品', why: '品牌' };
  }
  // 4) 钩子 / 行动号召
  const isCta = (R.cta_patterns || []).some(p => new RegExp(p).test(line));
  const isHook = (R.hook_patterns || []).some(p => new RegExp(p).test(line));
  if (isCta || isHook) {
    if (mode === 'onscreen') return { tag: '出境', why: isCta ? 'CTA' : '钩子' };
    const cands = ['大景', '外门头', '车流', '单品'];
    return { tag: cands[0], why: isCta ? 'CTA(无出镜)' : '钩子(无出镜)' };
  }
  return null;
}
/* tag 里写 "出境/大景" = 真人出镜用前一个、无出镜用后一个 */
function pickTag(tag, mode) {
  if (!tag || !tag.includes('/')) return tag;
  const [a, b] = tag.split('/');
  return mode === 'onscreen' ? a : (b || a);
}
function addFenjingText(text, preset, mode, onlyEmpty) {
  const lines = text.split('\n');
  const out = []; let changed = 0, unknown = 0;
  const addedIdx = [];          // 本次新加标注的行号（用于预览高亮）
  const bodyCount = lines.filter((l, i) => i > 0 && l.trim()).length;
  // 开头 N 行默认做口播（太短的稿子不启用，避免整条被口播吃掉）
  const openN = bodyCount >= 4 ? ((preset.add_rule && preset.add_rule.opening_lines) || 0) : 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    const isTitle = i === 0 && /^(封面标题|顶部文案)/.test(t);
    if (!t || isTitle || isWhitelisted(t, preset)) { out.push(line); return; }
    if (HAS_TAG.test(line)) {
      if (onlyEmpty) { out.push(line); return; }
      line = line.replace(TAG_RE, '').replace(/\s+$/, '');
    }
    // 先按关键词规则匹配（具体规则优先）
    const r = matchTag(line, preset, mode);
    if (r) { out.push(line + `【${r.tag}】`); changed++; addedIdx.push(i); return; }
    // 没命中、又在开头几行 → 默认口播镜头（真人出镜→出境；无出镜→大景）
    if (openN && i >= 1 && i <= openN) {
      const tag = mode === 'onscreen' ? '出境' : '大景';
      out.push(line + `【${tag}】`); changed++; addedIdx.push(i); return;
    }
    out.push(line); unknown++;
  });
  return { text: out.join('\n'), changed, unknown, addedIdx };
}

/* ---------- ② 去出镜 ---------- */
const SYN_GROUPS = [                       // 语义同组：替换后清理重复的旧标签
  ['大景', '长镜头', '外景', '全景', '中景', '特写', '空镜', '转场'],
  ['商场', '商场画面'],
  ['网购画面'],
  ['体验', '体验画面', '体验产品', '人群体验'],
  ['人群', '客户', '业主'],
  ['单品', '单品展示', '展示单品', '单品九宫格'],
  ['细节', '品质', '材质'],
  ['工厂', '车间', '生产', '运输'],
  ['服务画面', '沟通画面', '送货画面'],
  ['价格标签']
];
function classifyLine(line) {
  const pats = [
    ['online_compare', /网购|网图|网上|电商|图片|盲盒|刷到爆/],
    ['mall_compare', /商场|品牌溢价|大牌溢价|翻上两三倍|品牌标|溢价/],
    ['price', /万|零头|预算|便宜|省|划算|实惠|价格|1\/3|一半/],
    ['touch_try', /摸|坐|试|躺|上手|亲手|体验|坐感|质感|拆/],
    ['service', /设计师|1对1|一对一|搭配|软装|全案|售后|验货|安装|解决/],
    ['factory', /源头|工厂|中间商|经销|自产自销|代工|生产线/],
    ['location', /机场|工业园|湖里|地址|定位|附近|公里|开车|车程|园区/],
    ['cta', /预约|私信|咨询|欢迎|过来|到店|逛逛|联系/],
    ['crowd', /业主|客户|朋友|姐妹|家人|大宅|装修|老板/],
    ['hook', /你知道|有没有|我发现|没想到|别再|千万|听我|为什么|居然|这路没白跑|不知道/],
  ];
  for (const [k, re] of pats) if (re.test(line)) return k;
  return 'default';
}
function stripChujingText(text, preset) {
  const C = preset.remove_chujing || {};
  const banned = new Set(C.banned_output || []);
  const cands = C.candidates || {};
  const disp = [];
  let changed = 0;
  const out = text.split('\n').map(line => {
    if (!/【出[境镜][^】]*】/.test(line)) return line;
    const cat = classifyLine(line);
    const pool = (cands[cat] || cands.default || ['大景']).filter(t => !banned.has(t));
    const tag = pool[0] || '大景';
    changed++;
    const display = line.replace(/【出[境镜][^】]*】/g, m => '\u0001' + m + '\u0002【' + tag + '】');
    let s = line.replace(/【出[境镜][^】]*】/g, `【${tag}】`);
    // 清理：删掉与新标签同语义组的旧标签（避免【体验画面】【体验】这类重复）
    const grp = SYN_GROUPS.find(g => g.includes(tag)) || [tag];
    s = s.replace(TAG_RE, (m, inner) => {
      if (inner === tag) return m;
      if (grp.includes(inner)) return '';
      return m;
    }).replace(/[ \t]+$/, '');
    // 兜底去重：完全相同的标注只留一个
    const seen = new Set();
    s = s.replace(TAG_RE, m => { if (seen.has(m)) return ''; seen.add(m); return m; }).replace(/[ \t]+$/, '');
    disp.push(display.replace(/[ \t]+$/, ''));
    return s;
  });
  return { text: out.join('\n'), display: disp.join('\n'), changed };
}

/* ---------- ③ 加挂载 ---------- */
function addGuazaiRows(rows, preset) {
  const rule = preset.guazai_rule || {};
  const byCount = rule.by_count || { '1': ['【挂私信】'], '2': ['【挂私信】', '【挂定位】'], '3': ['【挂私信】', '【挂定位】', '【挂私信】'] };
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = r.date || '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  let n = 0;
  groups.forEach(idxs => {
    let plan = byCount[String(idxs.length)];
    if (!plan) {                       // >3 条：私信/定位 交替，私信优先
      plan = idxs.map((_, k) => (k % 2 === 0 ? '【挂私信】' : '【挂定位】'));
    }
    idxs.forEach((ri, k) => {
      const mark = plan[k];
      if (!mark) return;
      if (rows[ri].script.startsWith('【挂')) return;
      rows[ri].script = mark + '\n' + rows[ri].script;
      n++;
    });
  });
  return n;
}

/* ---------- ④ 去分镜 ---------- */
function stripFenjingText(text, preset) {
  const set = tagSetOf(preset);
  let removed = 0; const unknown = [];
  const out = [], disp = [];
  text.split('\n').forEach(line => {
    let clean = line, display = line;
    const matches = [...line.matchAll(/【([^】]+)】/g)];
    for (let i = matches.length - 1; i >= 0; i--) {      // 从后往前改，位置不串
      const m = matches[i], inner = m[1], s = m.index, e = s + m[0].length;
      if (isWhitelisted('【' + inner + '】', preset)) continue;          // 白名单：保留不报
      if (!isFenjingTag(inner, set)) { unknown.push(inner); continue; } // 词库外：保留并提示
      removed++;
      clean = clean.slice(0, s) + clean.slice(e);
      display = display.slice(0, s) + '\u0001' + m[0] + '\u0002' + display.slice(e);  // 标记：预览画删除线
    }
    out.push(clean.replace(/[ \t]+$/, ''));
    disp.push(display.replace(/[ \t]+$/, ''));
  });
  return { text: out.join('\n'), display: disp.join('\n'), removed, unknown: [...new Set(unknown)] };
}

/* ---------- ⑤ 替换表 ---------- */
function applyReplaceText(text, preset, dir, scope, onlyOn) {
  const table = preset.replace_table || [];
  const protects = (preset.replace_table_protect || []).filter(Boolean);
  let changed = 0;
  const disp = [];
  const out = text.split('\n').map(line => {
    const isTitle = /^\s*(封面标题|顶部文案)/.test(line);
    if (scope === 'title' && !isTitle) return line;
    if (scope === 'body' && isTitle) return line;
    let s = line;
    // 保护词先挖出来（如「佛山工厂」里的城市名不参与替换），替换完放回
    const saved = [];
    protects.forEach((w, i) => {
      if (s.includes(w)) { saved.push([i, w]); s = s.split(w).join(`\u0000P${i}\u0000`); }
    });
    table.forEach(item => {
      if (onlyOn && !item.on) return;
      if (!item.vals || !item.vals.length) return;
      const vals = item.vals.slice().sort((a, b) => b.length - a.length);
      if (dir === 'fill') {
        const v = item.current || vals[0];
        if (s.includes(item.ph)) s = s.split(item.ph).join(v);
      } else {
        vals.forEach(v => { if (s.includes(v)) s = s.split(v).join(item.ph); });
      }
    });
    // 展示版：把「原词 → 新词」都标出来（原词划掉）
    let display = line;
    table.forEach(item => {
      if (onlyOn && !item.on) return;
      if (!item.vals || !item.vals.length) return;
      const vals = item.vals.slice().sort((a, b) => b.length - a.length);
      if (dir === 'fill') {
        const v = item.current || vals[0];
        display = display.split(item.ph).join('\u0001' + item.ph + '\u0002' + v);
      } else {
        vals.forEach(v => { display = display.split(v).join('\u0001' + v + '\u0002' + item.ph); });
      }
    });
    saved.forEach(([i, w]) => { s = s.split(`\u0000P${i}\u0000`).join(w); });
    if (s !== line) changed++;
    disp.push(display.replace(/[ \t]+$/, ''));
    return s;
  });
  return { text: out.join('\n'), display: disp.join('\n'), changed };
}

/* ---------- ⑥ 红线检测 ---------- */
function scanRedline(text, preset) {
  const hits = [], spans = [];
  (preset.redline_groups || []).forEach(g => {
    if (!g.on) return;
    const words = (g.words || []).filter(Boolean).sort((a, b) => b.length - a.length);  // 长词优先
    words.forEach(w => {
      let idx = -1;
      while ((idx = text.indexOf(w, idx + 1)) !== -1) {
        const end = idx + w.length;
        if (spans.some(s => idx < s.end && end > s.start)) continue;   // 已被更长的词覆盖
        spans.push({ start: idx, end });
        hits.push({ word: w, group: g.group, idx, end });
      }
    });
  });
  return hits.sort((a, b) => a.idx - b.idx);
}

/* ======================================================================
   Excel 读写
   ====================================================================== */
function fmtDate(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'number' && v > 40000 && v < 60000) {
    const d = new Date((v - 25569) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})月(\d{1,2})日/);          // 「9月23日」这类不写年份的
  if (m2) return `${new Date().getFullYear()}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  return null;
}
function analyze(aoa) {
  const rows0 = aoa.filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
  if (!rows0.length) return null;
  const colCount = Math.max(...rows0.map(r => r.length));
  const score = { d: 0, l: 0, s: 0 };
  const byCol = [];
  for (let c = 0; c < colCount; c++) {
    const sc = { d: 0, l: 0, s: 0 };
    rows0.forEach(row => {
      const v = row[c];
      if (v === '' || v === null || v === undefined) return;
      const str = String(v);
      if (/^https?:\/\//.test(str.trim())) sc.l += 3;
      else if (fmtDate(v)) sc.d += 3;
      if (str.length > 60 || str.includes('\n')) sc.s += 3;
      else if (str.length > 18) sc.s += 1;
    });
    byCol.push(sc);
  }
  const pick = key => {
    let best = -1, bi = -1;
    byCol.forEach((sc, i) => { if (sc[key] > best) { best = sc[key]; bi = i; } });
    return best > 0 ? bi : -1;
  };
  const sCol = pick('s'); const lCol = pick('l'); const dCol = pick('d');
  return rows0.map((row, i) => {
    const cells = row.slice();
    while (cells.length < colCount) cells.push('');
    return {
      idx: i, cells, colCount,
      date: dCol >= 0 ? fmtDate(row[dCol]) : null,
      link: lCol >= 0 ? String(row[lCol] || '') : '',
      script: sCol >= 0 ? String(row[sCol] || '') : '',
      rawScript: sCol >= 0 ? String(row[sCol] || '') : '',   // 原始文案，每次处理从它重算
      scriptCol: sCol
    };
  });
}
function exportRows(rows, filename) {
  const aoa = rows.map(r => { const c = r.cells.slice(); if (r.scriptCol >= 0) c[r.scriptCol] = r.script; return c; });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}
function readFile(file, cb) {
  const fr = new FileReader();
  fr.onload = e => {
    const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    cb(analyze(aoa));
  };
  fr.readAsArrayBuffer(file);
}

/* ======================================================================
   界面接线
   ====================================================================== */
const ST = {};   // 各页状态 { rows, redlineWords }
['addfj', 'rmcj', 'gz', 'rmfj', 'rep', 'rl'].forEach(k => { ST[k] = { rows: null, extra: null }; });

function bindDrop(dropId, inputId, key, after) {
  const drop = $(dropId), input = $(inputId);
  drop.onclick = () => input.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
  };
  input.onchange = () => { if (input.files[0]) handle(input.files[0]); };
  function handle(f) {
    readFile(f, rows => {
      if (!rows) { alert('没读到内容，请确认文件格式'); return; }
      ST[key].rows = rows;
      drop.innerHTML = `已载入：<b>${esc(f.name)}</b> · ${rows.length} 行 · 点此换文件`;
      $(dropId.replace('drop-', 'run-')).disabled = false;
      if (after) after(rows);
    });
  }
}

/* 预览渲染 */
function lineType(line, i, ri, opts) {
  if (/^\s*(封面标题|顶部文案)/.test(line)) return 'title';   // 按内容判断标题（挂载行在最前面，不能按位置判）
  if (!line.trim()) return 'blank';
  if (opts.mode === 'rmfj') {                      // 去分镜：看标注有没有被删掉
    if (line.indexOf('\u0001') !== -1) return 'deleted';
    const m = line.match(/【([^】]+)】/);
    if (m) return isWhitelisted('【' + m[1] + '】', opts.preset || CUR) ? 'kept' : 'unknown';
    return 'plain';
  }
  if (opts.mode === 'rmcj' || opts.mode === 'rep') {   // 去出镜 / 替换表：看这行有没有被改
    return (line.indexOf('\u0001') !== -1) ? 'changed' : 'plain';
  }
  if (opts.mode === 'gz') {                         // 加挂载：看这行有没有挂载标签
    return /^【挂(私信|定位)】/.test(line.trim()) ? 'mount' : 'plain';
  }
  if (opts.mode === 'rl') {                         // 红线检测：看这行有没有红线词
    const words = opts.redlineWords || [];
    return words.some(w => w && line.indexOf(w) !== -1) ? 'hit' : 'plain';
  }
  if (opts.newLines && opts.newLines.has(ri + '-' + i)) return 'new';
  if (HAS_TAG.test(line)) return 'old';
  return 'none';                                   // 没标上（黄）
}
function renderPreview(container, rows, opts = {}) {
  if (!rows || !rows.length) { container.innerHTML = '<div class="empty">还没有数据</div>'; return; }
  const rlWords = opts.redlineWords || [];
  const filter = opts.filter || 'all';
  const tally = { new: 0, old: 0, none: 0, deleted: 0, kept: 0, unknown: 0, plain: 0, changed: 0, mount: 0, hit: 0, total: 0 };
  let html = '<table><thead><tr><th style="width:90px">日期</th><th style="width:26%">链接</th><th>脚本（处理后）</th></tr></thead><tbody>';
  rows.forEach((r, ri) => {
    const src = (opts.useDisplay && r.display) ? r.display : r.script;
    const lines = src.split('\n');
    const types = lines.map((line, i) => lineType(line, i, ri, opts));
    types.forEach(tp => {
      if (tp === 'title' || tp === 'blank') return;
      tally.total++;
      if (tally[tp] !== undefined) tally[tp]++;
    });
    // 以「整条脚本」为单位筛选：这条里有匹配行 → 整条完整显示；没有 → 整条不显示
    const hit = (filter === 'all') || types.some(tp => tp === filter);
    if (!hit) return;
    const body = lines.map((line, i) => {
      const tp = types[i];
      let h = esc(line);
      rlWords.forEach(w => { if (w) h = h.split(esc(w)).join(`<mark class="rl">${esc(w)}</mark>`); });
      const isNew = tp === 'new';
      h = h.replace(/【([^】]+)】/g, (m, inner) => `<span class="tag${isNew ? ' new' : ''}">【${esc(inner)}】</span>`);
      let cls = '';
      if (opts.mode === 'rmfj') {
        if (tp === 'unknown') cls = 'warnrow';
        else if (tp === 'kept') cls = 'keeprow';
      } else if (opts.mode === 'gz') {
        if (tp === 'mount') cls = 'mountrow';
      } else if (opts.mode === 'rl') {
        if (tp === 'hit') cls = 'hitrow';
      } else if (opts.markUnknown && tp === 'none') cls = 'warnrow';
      h = h.split('\u0001').join('<del>').split('\u0002').join('</del>');
      const ln = tp === 'title' ? '' : `<span class="ln">${i}</span>`;
      return `<div class="${cls}">${ln}${h || '&nbsp;'}</div>`;
    }).join('');
    html += `<tr><td>${esc(r.date || '')}</td><td class="txt">${esc(r.link)}</td><td class="txt">${body}</td></tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
  if (opts.tallyInto && $(opts.tallyInto)) {
    const MAP = {
      rmfj: `共 ${tally.total} 行 ｜ 已删掉 <b style="color:#dc2626">${tally.deleted}</b> ｜ 白名单保留 <b style="color:var(--pri)">${tally.kept}</b> ｜ 没认出来 <b style="color:#b45309">${tally.unknown}</b>`,
      rmcj: `共 ${tally.total} 行 ｜ 换掉出镜 <b style="color:#15803d">${tally.changed}</b> ｜ 没动 <b style="color:#6b7280">${tally.plain}</b>`,
      rep:  `共 ${tally.total} 行 ｜ 替换过 <b style="color:#15803d">${tally.changed}</b> ｜ 没变 <b style="color:#6b7280">${tally.plain}</b>`,
      gz:   `共 ${tally.total} 行 ｜ 已挂载 <b style="color:#15803d">${tally.mount}</b> ｜ 未挂载 <b style="color:#6b7280">${tally.plain}</b>`,
      rl:   `共 ${tally.total} 行 ｜ 命中红线 <b style="color:#dc2626">${tally.hit}</b> ｜ 干净 <b style="color:#0f9d58">${tally.plain}</b>`,
    };
    if (MAP[opts.mode]) {
      $(opts.tallyInto).innerHTML = MAP[opts.mode];
    } else {
      $(opts.tallyInto).innerHTML = `共 ${tally.total} 行台词 ｜ 新加 <b style="color:#15803d">${tally.new}</b> ｜ 原有 <b style="color:var(--pri)">${tally.old}</b> ｜ 没标上 <b style="color:#b45309">${tally.none}</b>`;
    }
  }
}

/* ---------- 加分镜 / 去分镜：先看文档状态，避免白做 ---------- */
function fenjingState(rows, preset) {
  const set = tagSetOf(preset);
  let total = 0, tagged = 0, tags = 0;
  rows.forEach(r => {
    (r.script || '').split('\n').forEach((line, i) => {
      if (i === 0) return;
      if (!line.trim()) return;
      total++;
      const found = [...line.matchAll(/【([^】]+)】/g)].map(m => m[1]);
      const fj = found.filter(x => isFenjingTag(x, set));
      if (fj.length) { tagged++; tags += fj.length; }
    });
  });
  return { total, tagged, tags };
}
function renderFjState(rows, which) {
  const el = $(which === 'add' ? 'fjState' : 'rmfjState');
  if (!el || !rows) return;
  const st = fenjingState(rows, CUR);
  if (which === 'add') {
    if (!st.total) { el.innerHTML = ''; return; }
    if (st.tagged === 0) {
      el.innerHTML = `<div class="okline">✅ 这份文档<b>还没有分镜</b>（共 ${st.total} 行台词），可以加。</div>`;
    } else if (st.tagged >= st.total) {
      el.innerHTML = `<div class="issue">⚠️ 这份文档<b>已经有分镜了</b>（${st.tagged}/${st.total} 行都带标注），<b>不需要再加</b>。<br>
        想重新标一遍的话，先取消勾选下面的「只处理没有标注的行」。</div>`;
    } else {
      el.innerHTML = `<div class="issue">ℹ️ 这份文档已有 <b>${st.tagged}</b> 行带标注，还有 <b>${st.total - st.tagged}</b> 行没标（共 ${st.total} 行）——只会补没标的那部分。</div>`;
    }
  } else {
    if (st.tags === 0) {
      el.innerHTML = `<div class="issue">⚠️ 这份文档<b>没有分镜标注</b>，<b>不需要删</b>。</div>`;
    } else {
      el.innerHTML = `<div class="okline">✅ 文档里有 <b>${st.tags}</b> 个分镜标注（分布在 ${st.tagged} 行），可以删。</div>`;
    }
  }
}

/* ---------- 各功能的「重复劳动」检查 ---------- */
function chujingState(rows) {
  let lines = 0, tags = 0;
  rows.forEach(r => ((r.script || '').split('\n')).forEach(l => {
    const m = l.match(/【出[境镜][^】]*】/g);
    if (m) { lines++; tags += m.length; }
  }));
  return { lines, tags };
}
function renderRmCjState(rows) {
  const el = $('rmcjState'); if (!el || !rows) return;
  const st = chujingState(rows);
  if (st.tags === 0) el.innerHTML = `<div class="issue">⚠️ 这份文档里<b>没有出镜标注</b>（【出境】/【出镜】都没有），<b>不需要去出镜</b>。</div>`;
  else el.innerHTML = `<div class="okline">✅ 找到 <b>${st.tags}</b> 处出镜标注（分布在 ${st.lines} 行），可以处理。</div>`;
}
function guazaiState(rows) {
  let mounted = 0;
  rows.forEach(r => { if (/^【挂(私信|定位)】/.test((r.script || '').trim())) mounted++; });
  return { mounted, total: rows.length };
}
function renderGzState(rows) {
  const el = $('gzState'); if (!el || !rows) return;
  const st = guazaiState(rows);
  if (st.total && st.mounted >= st.total) {
    el.innerHTML = `<div class="issue">⚠️ 这份文档<b>每一条都已经挂好了</b>（${st.mounted}/${st.total} 条已带挂载标注），<b>不需要再挂</b>。</div>`;
  } else if (st.mounted > 0) {
    el.innerHTML = `<div class="issue">ℹ️ 已经有 <b>${st.mounted}</b> 条挂了，还有 <b>${st.total - st.mounted}</b> 条没挂——只会补没挂的那部分。</div>`;
  } else {
    el.innerHTML = `<div class="okline">✅ 还没有挂载标注（共 ${st.total} 条脚本），可以处理。</div>`;
  }
}
function repHits(rows, dir) {
  const table = (CUR.replace_table || []).filter(it => it.on);
  const detail = new Set(); let hits = 0;
  rows.forEach(r => ((r.script || '').split('\n')).forEach(line => {
    table.forEach(it => {
      if (dir === 'fill') { if (line.includes(it.ph)) { hits++; detail.add(it.ph); } }
      else { it.vals.forEach(v => { if (v && line.includes(v)) { hits++; detail.add(v); } }); }
    });
  }));
  return { hits, detail: [...detail] };
}
function renderRepState(rows) {
  const el = $('repState'); if (!el || !rows) return;
  const fill = repHits(rows, 'fill'), ph = repHits(rows, 'ph');
  if (!fill.hits && !ph.hits) {
    el.innerHTML = `<div class="issue">⚠️ 这份文档里<b>没有可替换的词</b>——占位符（xx（城市）、x平、xx（区）…）和对应的实际内容都没找到，<b>不需要替换</b>。</div>`;
  } else {
    const s = [];
    if (fill.hits) s.push(`「填入实值」可替换 <b>${fill.hits}</b> 处：${fill.detail.join('、')}`);
    if (ph.hits) s.push(`「还原占位符」可替换 <b>${ph.hits}</b> 处：${ph.detail.join('、')}`);
    el.innerHTML = `<div class="okline">✅ ${s.join(' ｜ ')}</div>`;
  }
}

/* ---------- 加挂载：日期检查 ---------- */
function dateStats(rows) {
  const miss = rows.filter(r => !r.date).length;
  const days = new Set(rows.map(r => r.date).filter(Boolean));
  return { total: rows.length, miss, days: days.size };
}
function renderDateWarn(rows) {
  const el = $('dateWarn'); if (!el || !rows) return;
  const { total, miss, days } = dateStats(rows);
  if ($('run-gz')) $('run-gz').disabled = false;
  if (miss === 0) {
    el.innerHTML = `<div class="okline">✅ 已识别到日期列：共 <b>${days}</b> 个日期、${total} 条脚本（每条都带日期）</div>`;
  } else if (miss === total) {
    if ($('run-gz')) $('run-gz').disabled = true;      // 直接禁用按钮，避免误操作
    el.innerHTML = `<div class="issue">⚠️ <b>这个文档里没有日期</b>，没法按日期分配挂载。<br>
      请在 Excel 里加一列「日期」（例如 <code class="k">2026-09-23</code> 或 <code class="k">9月23日</code>），保存后重新拖进来。<br>
      挂载规则：同一天的第 1 条挂【挂私信】、第 2 条挂【挂定位】、第 3 条再补【挂私信】。</div>`;
  } else {
    el.innerHTML = `<div class="issue">⚠️ 有 <b>${miss}</b> 行没识别到日期（其余 ${total - miss} 行有日期）。<br>
      这些行会被当成"同一天"处理，建议把日期补齐再导一次。</div>`;
  }
}

/* ---------- 各功能执行 ---------- */
function runAddFj() {
  const src = ST.addfj.rows;
  const st0 = fenjingState(src, CUR);
  if (st0.total && st0.tagged >= st0.total) {
    renderFjState(src, 'add');
    alert(`⚠️ 这份文档已经加过分镜了（${st0.tagged}/${st0.total} 行都带标注），不需要再加。\n\n如果你想重新标一遍，先取消勾选「只处理没有标注的行」。`);
    return;
  }
  const modeEl = document.querySelector('input[name=addfj-mode]:checked');
  const mode = (modeEl && modeEl.value === 'off') ? 'off' : 'onscreen';
  const onlyEmpty = $('addfj-onlyEmpty').checked;
  const rows = ST.addfj.rows.map(r => ({ ...r, script: r.rawScript }));
  let ch = 0, un = 0; const newLines = new Set();
  rows.forEach((r, ri) => {
    const res = addFenjingText(r.script, CUR, mode, onlyEmpty);
    r.script = res.text; ch += res.changed; un += res.unknown;
    (res.addedIdx || []).forEach(i => newLines.add(ri + '-' + i));
  });
  ST.addfj.rows = rows;
  ST.addfj.unknownCount = un;
  ST.addfj.newLines = newLines;
  renderPreview($('pv-addfj'), rows, { markUnknown: true, newLines, filter: (ST.addfj && ST.addfj.filter) || 'all', tallyInto: 'fjCount' });
  $('stat-addfj').innerHTML = `已标注 <b>${ch}</b> 行，未命中 <b>${un}</b> 行（黄色需人工补，可点右侧导出待补清单反馈）`;
  $('exp-addfj').disabled = false;
  $('fb-addfj').disabled = un === 0;
  renderFjState(rows, 'add');
}
function runRmCj() {
  const src0 = ST.rmcj.rows;
  const cj = chujingState(src0);
  if (cj.tags === 0) {
    renderRmCjState(src0);
    alert('⚠️ 这份文档里没有出镜标注（【出境】/【出镜】都没有），不需要去出镜。');
    return;
  }
  const rows = src0.map(r => ({ ...r, script: r.rawScript }));
  let ch = 0;
  const newLines = new Set();
  rows.forEach((r, ri) => {
    const res = stripChujingText(r.script, CUR);
    r.script = res.text; r.display = res.display; ch += res.changed;
    res.display.split('\n').forEach((l, i) => { if (l.indexOf('\u0001') !== -1) newLines.add(ri + '-' + i); });
  });
  ST.rmcj.rows = rows;
  renderPreview($('pv-rmcj'), rows, { useDisplay: true, mode: 'rmcj', filter: (ST.rmcj && ST.rmcj.filter) || 'all', tallyInto: 'rmcjCount' });
  renderRmCjState(rows);
  $('stat-rmcj').innerHTML = `替换出镜标注 <b>${ch}</b> 处（禁用词：${(CUR.remove_chujing.banned_output || []).join('、')}）`;
  $('exp-rmcj').disabled = false;
}
function runGz() {
  const src = ST.gz.rows;
  const { total, miss } = dateStats(src);
  if (miss === total) {
    renderDateWarn(src);
    alert('⚠️ 这个文档里没有日期，挂载没法算。\n\n挂载是按日期分配的：\n同一天的第 1 条挂【挂私信】、第 2 条挂【挂定位】，第 3 条再补【挂私信】。\n\n请在 Excel 里加一列「日期」（例如 2026-09-23 或 9月23日），保存后再拖进来。');
    return;
  }
  if (miss > 0 && !confirm(`有 ${miss} 行没有日期，会被当成"同一天"一起分配。要继续吗？`)) return;
  const gz = guazaiState(src);
  if (gz.total && gz.mounted >= gz.total) {
    renderGzState(src);
    alert('⚠️ 这份文档每一条都已经挂好了，不需要再挂。');
    return;
  }
  const rows = src.map(r => ({ ...r, script: r.rawScript }));
  const n = addGuazaiRows(rows, CUR);
  ST.gz.rows = rows;
  renderPreview($('pv-gz'), rows, { mode: 'gz', filter: (ST.gz && ST.gz.filter) || 'all', tallyInto: 'gzCount' });
  renderGzState(rows);
  const days = new Set(rows.map(r => r.date).filter(Boolean)).size;
  $('stat-gz').innerHTML = `共写入 <b>${n}</b> 个挂载标注 · ${days} 个日期`;
  $('exp-gz').disabled = false;
}
function runRmFj() {
  const src = ST.rmfj.rows;
  const st0 = fenjingState(src, CUR);
  if (st0.tags === 0) {
    renderFjState(src, 'rmfj');
    alert('⚠️ 这份文档里没有分镜标注，不需要删。\n\n（如果标注长得不一样，可能是词库里没有的写法，可以用「导出未知清单」反馈给我。）');
    return;
  }
  const rows = src.map(r => ({ ...r, script: r.rawScript }));
  let rm = 0; const unk = new Set();
  rows.forEach(r => { const res = stripFenjingText(r.script, CUR); r.script = res.text; r.display = res.display; rm += res.removed; res.unknown.forEach(u => unk.add(u)); });
  ST.rmfj.rows = rows;
  ST.rmfj.unknownTags = [...unk];
  renderPreview($('pv-rmfj'), rows, { useDisplay: true, mode: 'rmfj', filter: (ST.rmfj && ST.rmfj.filter) || 'all', tallyInto: 'rmfjCount' });
  $('fb-rmfj').disabled = unk.size === 0;
  renderFjState(rows, 'rmfj');
  $('stat-rmfj').innerHTML = `已删除 <b>${rm}</b> 个分镜标注` + (unk.size ? ` · 保留未知标注 ${[...unk].map(u => '【' + esc(u) + '】').join(' ')}（不在词库，需确认）` : '');
  $('exp-rmfj').disabled = false;
}
function runRep(dir) {
  const scope = $('repScope').value;
  const onlyOn = $('repOnlyOn').checked;
  const rp = repHits(ST.rep.rows, dir);
  if (rp.hits === 0) {
    renderRepState(ST.rep.rows);
    alert(dir === 'fill'
      ? '⚠️ 这份文档里没有占位符（没找到 xx（城市）/x平/xx（区）这类），不需要替换。'
      : '⚠️ 这份文档里没有可还原的实际内容（没找到占位符对应的城市/面积等具体写法），不需要替换。');
    return;
  }
  const rows = ST.rep.rows.map(r => ({ ...r, script: r.rawScript }));
  let ch = 0;
  rows.forEach(r => { const res = applyReplaceText(r.script, CUR, dir, scope, onlyOn); r.script = res.text; r.display = res.display; ch += res.changed; });
  ST.rep.rows = rows;
  renderPreview($('pv-rep'), rows, { useDisplay: true, mode: 'rep', filter: (ST.rep && ST.rep.filter) || 'all', tallyInto: 'repCount' });
  renderRepState(rows);
  $('stat-rep').innerHTML = `${dir === 'fill' ? '填入实值' : '还原占位符'}：改动 <b>${ch}</b> 行`;
  $('exp-rep').disabled = false;
}
function runRl() {
  const rows = ST.rl.rows.map(r => ({ ...r, script: r.rawScript }));
  const all = [];
  rows.forEach(r => {
    const hits = scanRedline(r.script, CUR);
    if (hits.length) all.push({ row: r, hits });
  });
  ST.rl.rows = rows;
  const words = [...new Set(all.flatMap(a => a.hits.map(h => h.word)))];
  ST.rl.words = words;
  renderPreview($('pv-rl'), rows, { redlineWords: words, mode: 'rl', filter: (ST.rl && ST.rl.filter) || 'all', tallyInto: 'rlCount' });
  let list = '';
  if (!all.length) list = '<div class="okline">✅ 未发现红线词</div>';
  all.forEach(a => {
    const byGroup = {};
    a.hits.forEach(h => { (byGroup[h.group] = byGroup[h.group] || []).push(h.word); });
    const lines = a.row.script.split('\n');
    const det = Object.entries(byGroup).map(([g, ws]) => `${g}：<b>${[...new Set(ws)].join(' ')}</b>`).join(' ｜ ');
    list += `<div class="issue">${esc(a.row.date || '')} ${esc(a.row.link.slice(0, 40))}<br>${det}</div>`;
  });
  $('rlResult').innerHTML = list;
  $('stat-rl').innerHTML = `命中 <b>${all.length}</b> 条脚本 · ${all.reduce((s, a) => s + a.hits.length, 0)} 处（只提示，不会自动改字）`;
  $('exp-rl').disabled = false;
}

/* ---------- 反馈清单（使用者把"规则没认出来的"交回来） ---------- */
function collectPendingLines(rows, preset) {
  const map = new Map(); let total = 0;
  rows.forEach((r, ri) => {
    (r.script || '').split('\n').forEach((line, i) => {
      if (i === 0) return;
      const t = line.trim();
      if (!t || HAS_TAG.test(line) || isWhitelisted(t, preset)) return;
      total++;
      if (!map.has(t)) map.set(t, { count: 0, where: [] });
      const m = map.get(t); m.count++;
      const tag = `第${ri + 1}条`;
      if (!m.where.includes(tag)) m.where.push(tag);
    });
  });
  return { map, total };
}
function sheetHeader(featureName, extra) {
  return [
    ['【分镜工具 · 规则反馈】'],
    ['门店', (CUR.label || PRESET)],
    ['规则版本', RULES.version || ''],
    ['功能', featureName + (extra ? '（' + extra + '）' : '')],
    ['导出时间', new Date().toLocaleString('zh-CN')],
    [],
  ];
}
function exportPendingXlsx(rows, preset, featureName, extra) {
  const { map, total } = collectPendingLines(rows, preset);
  if (!map.size) { alert('这次没有未命中的台词，不需要反馈 🎉'); return null; }
  const aoa = sheetHeader(featureName, extra).concat([['未命中的台词（请补「建议标注」后回传）', '出现次数', '出现在', '建议标注（请填写）', '备注']]);
  [...map.entries()].sort((a, b) => b[1].count - a[1].count)
    .forEach(([t, m]) => aoa.push([t, m.count, m.where.join('、'), '', '']));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 46 }, { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '待补清单');
  XLSX.writeFile(wb, `规则反馈_${preset.label || PRESET}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return { kinds: map.size, total };
}
function exportUnknownXlsx(tags, preset, featureName) {
  if (!tags || !tags.length) { alert('没有词库外的标注，不需要反馈 🎉'); return null; }
  const aoa = sheetHeader(featureName, '').concat([['词库外的【标注】（请选择处理方式）', '出现次数', '建议（保留 / 当分镜删除 / 加进白名单）']]);
  const cnt = new Map();
  tags.forEach(t => cnt.set(t, (cnt.get(t) || 0) + 1));
  [...cnt.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => aoa.push([`【${t}】`, c, '']));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 46 }, { wch: 10 }, { wch: 34 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '未知标注');
  XLSX.writeFile(wb, `规则反馈_未知标注_${preset.label || PRESET}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return { kinds: cnt.size };
}

/* ---------- 规则改动落盘 ---------- */
function ensurePresetField(field) {
  const p = RULES.presets[PRESET];
  if (!p[field]) p[field] = clone(CUR[field]);
  return p[field];
}
function saveAndRefresh() {
  localStorage.setItem(LS_RULES, JSON.stringify(RULES));
  RULE_SOURCE = '本机自定义';
  initRules();
}
function addRedlineWords(text, targetGroup) {
  const groups = ensurePresetField('redline_groups');
  let added = 0, skipped = 0;
  text.split('\n').forEach(line => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[,，\t]/).map(x => x.trim()).filter(Boolean);
    const word = parts[0], gname = parts[1] || targetGroup;
    if (!word) return;
    let g = groups.find(x => x.group === gname);
    if (!g) { g = { group: gname, on: true, words: [] }; groups.push(g); }
    if (g.words.includes(word)) { skipped++; return; }
    g.words.push(word); added++;
  });
  saveAndRefresh();
  return { added, skipped };
}

/* ---------- 规则面板 ---------- */
function renderRulePanels() {
  // 禁用输出列表
  const ban = $('banList');
  if (ban) ban.innerHTML = (CUR.remove_chujing.banned_output || []).map(t => `<code class="k">${esc(t)}</code>`).join(' ');
  // 挂载规则
  const gz = $('gzRuleView');
  if (gz) {
    const byCount = CUR.guazai_rule.by_count || {};
    gz.innerHTML = Object.keys(byCount).sort().map(k =>
      `<div class="hint">当天 <b>${k}</b> 条脚本 → ${byCount[k].map(m => `<code class="k">${esc(m)}</code>`).join(' ')}</div>`
    ).join('') + '<div class="hint">超过 3 条时按「私信 / 定位」交替，私信优先</div>';
  }
  // 白名单
  if ($('wl-exact')) $('wl-exact').textContent = (CUR.whitelist.exact || []).join('、') || '（无）';
  if ($('wl-contains')) $('wl-contains').textContent = (CUR.whitelist.contains || []).join('、') || '（无）';
  // 替换表（可直接手打，打过的自动记住）
  const rep = $('repTable');
  if (rep) {
    rep.innerHTML = '<table class="edit"><thead><tr><th style="width:20%">占位符</th><th>实际内容（可直接手打）</th><th style="width:56px">启用</th><th style="width:48px"></th></tr></thead><tbody>' +
      (CUR.replace_table || []).map((it, i) => {
        const cur = it.current || it.vals[0] || '';
        return `<tr>
          <td><code class="k">${esc(it.ph)}</code></td>
          <td>
            <input type="text" list="dl-rep-${i}" data-repinput="${i}" value="${esc(cur)}" placeholder="手打，或点输入框选" style="max-width:240px">
            <datalist id="dl-rep-${i}">${it.vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
            <span class="hint" style="margin-left:8px">已记住：${it.vals.map(v => `<a href="#" data-reppick="${i}" data-val="${esc(v)}">${esc(v)}</a>`).join(' / ') || '（还没有）'}</span>
          </td>
          <td><input type="checkbox" data-repon="${i}" ${it.on ? 'checked' : ''}></td>
          <td><button class="btn mini" data-repdel="${i}" title="删除这一条">✕</button></td>
        </tr>`;
      }).join('') + '</tbody></table>';
  }
  // 红线分组
  const rg = $('rlGroups');
  if (rg) {
    rg.innerHTML = (CUR.redline_groups || []).map((g, i) =>
      `<div class="grp" style="margin:8px 0"><label class="ck"><input type="checkbox" data-rl="${i}" ${g.on ? 'checked' : ''}> <b>${esc(g.group)}</b>（${g.words.length} 词）</label>
       <div class="hint">${esc(g.words.slice(0, 30).join('、'))}${g.words.length > 30 ? ' …' : ''}</div></div>`
    ).join('');
    rg.querySelectorAll('input[data-rl]').forEach(c => {
      c.onchange = () => { CUR.redline_groups[+c.dataset.rl].on = c.checked; };
    });
  }
  // 红线词库：目标分组下拉 + 词数统计
  const sel = $('rlTargetGroup');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = (CUR.redline_groups || []).map(g => `<option>${esc(g.group)}</option>`).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }
  if ($('rlWordStat')) {
    $('rlWordStat').textContent = (CUR.redline_groups || []).map(g => `${g.group} ${g.words.length} 词`).join(' · ');
  }
}

/* ======================================================================
   规则库：可视化编辑（① 关键词规则 ② 名单 ③ 白名单 ④ 替换表 ⑤ 挂载）
   ====================================================================== */
function allTagOptions() {
  const set = new Set();
  Object.values(CUR.fenjing_tags || {}).forEach(arr => arr.forEach(t => set.add(t)));
  ['出境/大景', '出境/人群', '出境/单品', '品质/细节', '单品*N', '风格*N'].forEach(t => set.add(t));
  return [...set];
}
function linesToArr(s) { return s.split('\n').map(x => x.trim()).filter(Boolean); }

function renderVisualEditor() {
  const A = CUR.add_rule || {};
  // ① 关键词规则
  const tb = $('ruleBody');
  if (tb) {
    const rules = A.rules || [];
    tb.innerHTML = rules.map((r, i) => `
      <tr>
        <td><input type="text" data-rulepat="${i}" value="${esc(r.pat || '')}"></td>
        <td><select data-ruletag="${i}">${allTagOptions().map(t => `<option ${t === r.tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></td>
        <td style="white-space:nowrap">
          <button class="btn mini" data-ruleup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn mini" data-ruledown="${i}" ${i === rules.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn mini" data-ruledel="${i}">✕</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="3" class="hint">还没有规则，用下面输入框加一条</td></tr>';
  }
  // 新增规则的镜头下拉
  const nrt = $('newRuleTag');
  if (nrt && nrt.options.length === 0) {
    nrt.innerHTML = allTagOptions().map(t => `<option>${esc(t)}</option>`).join('');
  }
  // ② 名单
  if ($('prodList')) $('prodList').value = (A.products || []).join('\n');
  if ($('brandList')) $('brandList').value = (A.brands || []).join('\n');
  if ($('styleList')) $('styleList').value = (A.style_words || []).join('\n');
  // ③ 白名单
  const wl = CUR.whitelist || {};
  if ($('wlExact')) $('wlExact').value = (wl.exact || []).join('\n');
  if ($('wlContains')) $('wlContains').value = (wl.contains || []).join('\n');
  // ④ 替换表
  const rb = $('repEditBody');
  if (rb) {
    rb.innerHTML = '<tr><th style="width:30%">占位符</th><th>实际内容（多个用 | 分隔）</th><th style="width:60px">启用</th><th style="width:50px"></th></tr>' +
      (CUR.replace_table || []).map((it, i) => `
      <tr>
        <td><input type="text" data-ph="${i}" value="${esc(it.ph)}"></td>
        <td><input type="text" data-phvals="${i}" value="${esc(it.vals.join(' | '))}"></td>
        <td><input type="checkbox" data-phon="${i}" ${it.on ? 'checked' : ''}></td>
        <td><button class="btn mini" data-phdel="${i}">✕</button></td>
      </tr>`).join('');
  }
  // ⑤ 挂载规则
  const ge = $('gzEdit');
  if (ge) {
    const bc = (CUR.guazai_rule || {}).by_count || {};
    ge.innerHTML = ['1', '2', '3'].map(k => `
      <div class="row" style="margin:6px 0">
        <span style="width:150px">当天 <b>${k}</b> 条脚本 →</span>
        <input type="text" data-gz="${k}" value="${esc((bc[k] || []).join(','))}" placeholder="【挂私信】,【挂定位】" style="flex:1">
      </div>`).join('') + '<div class="hint">用英文逗号分隔，按顺序对应第 1 条、第 2 条…</div>';
  }
}

function moveRule(i, dir) {
  const rules = CUR.add_rule.rules;
  const j = i + dir;
  if (j < 0 || j >= rules.length) return;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  persistRules(); renderVisualEditor();
}

function persistRules() {
  const p = RULES.presets[PRESET];
  ['add_rule', 'whitelist', 'replace_table', 'guazai_rule', 'redline_groups', 'replace_table_protect', 'remove_chujing']
    .forEach(f => { if (CUR[f] !== undefined) p[f] = clone(CUR[f]); });
  localStorage.setItem(LS_RULES, JSON.stringify(RULES));
  RULE_SOURCE = '本机自定义';
  if ($('verBadge')) $('verBadge').textContent = '规则 v' + (RULES.version || '?') + ' · 本机自定义';
  if ($('visualStat')) $('visualStat').textContent = '✓ 已自动保存（' + new Date().toLocaleTimeString('zh-CN') + '）';
}

function bindVisualEditor() {
  // 关键词规则：输入 / 换镜头 / 上下移 / 删除 / 新增
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.rulepat !== undefined) { CUR.add_rule.rules[+t.dataset.rulepat].pat = t.value; persistRules(); }
    else if (t.dataset.ph !== undefined) { CUR.replace_table[+t.dataset.ph].ph = t.value; persistRules(); }
    else if (t.dataset.phvals !== undefined) {
      CUR.replace_table[+t.dataset.phvals].vals = t.value.split('|').map(s => s.trim()).filter(Boolean); persistRules();
    }
    else if (t.dataset.gz !== undefined) {
      CUR.guazai_rule.by_count[t.dataset.gz] = t.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); persistRules();
    }
    else if (t.id === 'prodList') { CUR.add_rule.products = linesToArr(t.value); persistRules(); }
    else if (t.id === 'brandList') { CUR.add_rule.brands = linesToArr(t.value); persistRules(); }
    else if (t.id === 'styleList') { CUR.add_rule.style_words = linesToArr(t.value); persistRules(); }
    else if (t.dataset.repinput !== undefined) {
      const it = CUR.replace_table[+t.dataset.repinput];
      const v = t.value.trim();
      it.current = v;
      if (v && !it.vals.includes(v)) it.vals.push(v);   // 手打的新值自动记住
      persistRules();
    }
    else if (t.id === 'wlExact') { CUR.whitelist.exact = linesToArr(t.value); persistRules(); }
    else if (t.id === 'wlContains') { CUR.whitelist.contains = linesToArr(t.value); persistRules(); }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.ruletag !== undefined) { CUR.add_rule.rules[+t.dataset.ruletag].tag = t.value; persistRules(); }
    if (t.dataset.phon !== undefined) { CUR.replace_table[+t.dataset.phon].on = t.checked; persistRules(); }
    if (t.dataset.repon !== undefined) { CUR.replace_table[+t.dataset.repon].on = t.checked; persistRules(); }
    if (t.dataset.repinput !== undefined) { renderRulePanels(); }   // 失焦后刷新已记住列表
  });
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.ruleup !== undefined) moveRule(+t.dataset.ruleup, -1);
    else if (t.dataset.ruledown !== undefined) moveRule(+t.dataset.ruledown, 1);
    else if (t.dataset.ruledel !== undefined) {
      if (confirm('删除这条规则？')) { CUR.add_rule.rules.splice(+t.dataset.ruledel, 1); persistRules(); renderVisualEditor(); }
    }
    else if (t.dataset.phdel !== undefined) {
      if (confirm('删除这条替换？')) { CUR.replace_table.splice(+t.dataset.phdel, 1); persistRules(); renderVisualEditor(); }
    }
    else if (t.id === 'addRuleBtn') {
      const pat = $('newRulePat').value.trim();
      if (!pat) { alert('先在左边填关键词（多个用 | 分隔）'); return; }
      CUR.add_rule.rules.push({ name: '自定义', pat, tag: $('newRuleTag').value });
      $('newRulePat').value = '';
      persistRules(); renderVisualEditor();
      alert('已加到底部。想让它优先，点 ↑ 往上移。');
    }
    else if (t.id === 'addPhBtn') {
      const ph = $('newPh').value.trim(), vals = $('newPhVals').value.split('|').map(s => s.trim()).filter(Boolean);
      if (!ph || !vals.length) { alert('占位符和实际内容都要填'); return; }
      CUR.replace_table.push({ ph, vals, on: true });
      $('newPh').value = ''; $('newPhVals').value = '';
      persistRules(); renderVisualEditor();
    }
    else if (t.dataset.reppick !== undefined) {
      e.preventDefault();
      CUR.replace_table[+t.dataset.reppick].current = t.dataset.val;
      persistRules(); renderRulePanels();
    }
    else if (t.dataset.repdel !== undefined) {
      if (confirm('删除这一条替换？')) { CUR.replace_table.splice(+t.dataset.repdel, 1); persistRules(); renderRulePanels(); }
    }
    else if (t.id === 'repAddBtn') {
      const ph = $('repNewPh').value.trim(), vals = $('repNewVals').value.split('|').map(x => x.trim()).filter(Boolean);
      if (!ph || !vals.length) { alert('占位符和实际内容都要填'); return; }
      CUR.replace_table.push({ ph, vals, on: true, current: vals[0] });
      $('repNewPh').value = ''; $('repNewVals').value = '';
      persistRules(); renderRulePanels();
      alert('已添加：' + ph + ' → ' + vals[0]);
    }
    else if (t.id === 'saveVisual') { persistRules(); alert('已保存到本机 ✓\n（要让同事也用上，把规则文件发我，我推送到线上）'); }
    else if (t.id === 'resetVisual') { renderVisualEditor(); alert('已重新读取当前规则'); }
  });
}

/* ---------- 启动 ---------- */
function boot() {
  initRules();
  bindVisualEditor();
  // 页签
  document.querySelectorAll('nav button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('nav button').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('page-' + b.dataset.page).classList.add('active');
    };
  });
  // 预设切换
  $('presetSel').onchange = e => { PRESET = e.target.value; localStorage.setItem(LS_PRESET, PRESET); initRules(); };
  // 规则刷新 / 导入 / 保存 / 导出 / 恢复
  $('reloadRules').onclick = () => location.reload();
  $('importRules').onclick = () => $('ruleFile').click();
  $('ruleFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = ev => { try { RULES = JSON.parse(ev.target.result); localStorage.setItem(LS_RULES, JSON.stringify(RULES)); initRules(); alert('规则已导入'); } catch (err) { alert('规则文件格式不对：' + err.message); } };
    fr.readAsText(f);
  };
  $('saveRulesLocal').onclick = () => {
    try { RULES = JSON.parse($('rulesJson').value); localStorage.setItem(LS_RULES, JSON.stringify(RULES)); initRules(); alert('已保存到本机（以后打开都用这份）'); }
    catch (e) { alert('JSON 有语法错误：' + e.message); }
  };
  $('exportRules').onclick = () => {
    const blob = new Blob([JSON.stringify(RULES, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'rules.json'; a.click();
  };
  $('resetRules').onclick = () => {
    localStorage.removeItem(LS_RULES); RULES = clone(window.DEFAULT_RULES); initRules(); alert('已恢复服务器默认规则');
  };
  // 红线词库管理
  $('rlAddWords').onclick = () => {
    const txt = $('rlNewWords').value.trim();
    if (!txt) { alert('先在输入框里粘贴词（一行一个）'); return; }
    const target = $('rlTargetGroup').value || '自定义';
    const r = addRedlineWords(txt, target);
    $('rlNewWords').value = '';
    alert(`已添加 ${r.added} 个词到「${target}」` + (r.skipped ? `，${r.skipped} 个已存在被跳过` : '') + '\n（已保存到本机，检测立即生效）');
  };
  $('rlClearWords').onclick = () => { $('rlNewWords').value = ''; };
  $('rlImportWords').onclick = () => $('rlWordFile').click();
  $('rlWordFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = ev => {
      const txt = String(ev.target.result).replace(/^\uFEFF/, '');
      const target = $('rlTargetGroup').value || '自定义';
      const r = addRedlineWords(txt, target);
      alert(`导入完成：新增 ${r.added} 个词到「${target}」` + (r.skipped ? `，${r.skipped} 个重复已跳过` : ''));
    };
    fr.readAsText(f, 'utf-8');
  };
  $('rlAddNewGroup').onclick = () => {
    const name = prompt('新分组名称（如：违禁词、竞品敏感词）');
    if (!name) return;
    const groups = ensurePresetField('redline_groups');
    if (groups.find(g => g.group === name)) { alert('这个分组已存在'); return; }
    groups.push({ group: name, on: true, words: [] });
    saveAndRefresh();
    alert(`已新建分组「${name}」`);
  };
  // 预览筛选条（加分镜 / 去分镜通用）
  function bindFilterBar(barId, tab, pvId, extraOpts) {
    document.querySelectorAll('#' + barId + ' .fbtn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#' + barId + ' .fbtn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        ST[tab].filter = b.dataset.f;
        if (!ST[tab].rows) return;
        const o = Object.assign({}, extraOpts());
        o.filter = b.dataset.f;
        const CNT = { addfj: 'fjCount', rmfj: 'rmfjCount', rmcj: 'rmcjCount', rep: 'repCount', gz: 'gzCount', rl: 'rlCount' };
        o.tallyInto = CNT[tab];
        renderPreview($(pvId), ST[tab].rows, o);
      };
    });
  }
  bindFilterBar('fjFilters', 'addfj', 'pv-addfj', () => ({ markUnknown: true, newLines: ST.addfj.newLines }));
  bindFilterBar('rmfjFilters', 'rmfj', 'pv-rmfj', () => ({ useDisplay: true, mode: 'rmfj' }));
  bindFilterBar('rmcjFilters', 'rmcj', 'pv-rmcj', () => ({ useDisplay: true, mode: 'rmcj' }));
  bindFilterBar('repFilters', 'rep', 'pv-rep', () => ({ useDisplay: true, mode: 'rep' }));
  bindFilterBar('gzFilters', 'gz', 'pv-gz', () => ({ mode: 'gz' }));
  bindFilterBar('rlFilters', 'rl', 'pv-rl', () => ({ mode: 'rl', redlineWords: ST.rl.words || [] }));
  // 文件区
  bindDrop('drop-addfj', 'file-addfj', 'addfj', rows => renderFjState(rows, 'add'));
  bindDrop('drop-rmcj', 'file-rmcj', 'rmcj', rows => renderRmCjState(rows));
  bindDrop('drop-gz', 'file-gz', 'gz', rows => { renderDateWarn(rows); renderGzState(rows); });
  bindDrop('drop-rmfj', 'file-rmfj', 'rmfj', rows => renderFjState(rows, 'rmfj'));
  bindDrop('drop-rep', 'file-rep', 'rep', rows => renderRepState(rows));
  bindDrop('drop-rl', 'file-rl', 'rl');
  // 按钮
  $('run-addfj').onclick = runAddFj;
  $('run-rmcj').onclick = runRmCj;
  $('run-gz').onclick = runGz;
  $('run-rmfj').onclick = runRmFj;
  $('run-rep-fill').onclick = () => runRep('fill');
  $('run-rep-ph').onclick = () => runRep('ph');
  $('run-rl').onclick = runRl;
  $('exp-addfj').onclick = () => exportRows(ST.addfj.rows, '加分镜版.xlsx');
  $('fb-addfj').onclick = () => {
    const mode = document.querySelector('input[name=addfj-mode]:checked').value === 'off' ? '无真人出镜' : '真人出镜';
    const r = exportPendingXlsx(ST.addfj.rows, CUR, '加分镜', mode);
    if (r) alert(`已导出「待补清单」\n未命中 ${r.kinds} 种台词、共 ${r.total} 行\n\n请在表格的「建议标注」列填上想标的镜头，然后把文件发给维护者（Hermes），规则更新后刷新页面即生效。`);
  };
  $('fb-rmfj').onclick = () => {
    const tags = ST.rmfj.unknownTags || [];
    const r = exportUnknownXlsx(tags, CUR, '去分镜');
    if (r) alert(`已导出「未知标注清单」\n共 ${r.kinds} 种【标注】不在词库\n\n请标注处理方式（保留 / 当分镜删除 / 加进白名单），发回给维护者。`);
  };
  $('exp-rmcj').onclick = () => exportRows(ST.rmcj.rows, '去出镜版.xlsx');
  $('exp-gz').onclick = () => exportRows(ST.gz.rows, '挂载版.xlsx');
  $('exp-rmfj').onclick = () => exportRows(ST.rmfj.rows, '去分镜版.xlsx');
  $('exp-rep').onclick = () => exportRows(ST.rep.rows, '替换版.xlsx');
  $('exp-rl').onclick = () => {
    let txt = '红线检测报告\n\n';
    ST.rl.rows.forEach(r => {
      const hits = scanRedline(r.script, CUR);
      if (hits.length) {
        r.script.split('\n').forEach((line, i) => {
          hits.forEach(h => { if (line.includes(h.word)) txt += `[${r.date || ''}] 第${i}行 [${h.group}] ${h.word} ｜ ${line.trim()}\n`; });
        });
      }
    });
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '红线检测报告.txt'; a.click();
  };
}
document.addEventListener('DOMContentLoaded', boot);
