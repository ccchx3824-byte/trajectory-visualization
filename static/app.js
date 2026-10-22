const state = { page: 1, zoom: 1, records: [], record: null, selectedEvent: null, aiAnalyses: new Map(), aiAnalysisRequests: new Map(), comparisonAnalyses: new Map(), comparisonAnalysisRequests: new Map(), ai: { base_url: sessionStorage.getItem('traceExplorer.aiBaseUrl') || '', model: sessionStorage.getItem('traceExplorer.aiModel') || '', api_key: '' } };
const $ = (id) => document.getElementById(id);
const clip = (value, length = 210) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length) + (String(value ?? '').length > length ? '…' : '');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty = (value) => JSON.stringify(value, null, 2);
const eventKind = (message) => message.role === 'tool' ? 'tool' : message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system';
const laneFor = (message) => message.role === 'tool' ? 3 : message.role === 'assistant' ? 2 : 1;
function inlineMarkdown(text) {
  return text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/(?<!\*)\*(?!\s)([^*]*?\S)\*(?!\*)/g, '<em>$1</em>');
}
function renderMarkdown(value) {
  const mathBlocks = []; const protectedValue = String(value).replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => { const token = `@@MATHBLOCK${mathBlocks.length}@@`; mathBlocks.push(escape(`\\[${tex}\\]`)); return token; });
  const lines = escape(protectedValue).split('\n'); const html = []; let list = null; let code = false; let orderedIndex = 0;
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (/^```/.test(line)) { closeList(); code = !code; html.push(code ? '<pre><code>' : '</code></pre>'); continue; }
    if (code) { html.push(`${line}\n`); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/); const quote = line.match(/^&gt;\s?(.+)$/); const unordered = line.match(/^\s*[-*+]\s+(.+)$/); const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const math = line.trim().match(/^@@MATHBLOCK(\d+)@@$/);
    if (math) { closeList(); html.push(`<div class="math-block">${mathBlocks[Number(math[1])]}</div>`); }
    else if (heading) { closeList(); orderedIndex = 0; html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); }
    else if (quote) { closeList(); html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); }
    else if (unordered || ordered) { const type = unordered ? 'ul' : 'ol'; if (list !== type) { closeList(); list = type; html.push(type === 'ol' ? `<ol start="${orderedIndex + 1}">` : '<ul>'); } if (type === 'ol') orderedIndex += 1; html.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`); }
    else if (!line.trim()) {
      const next = lines.slice(lineIndex + 1).find(candidate => candidate.trim());
      const nextIsSameList = (list === 'ul' && /^\s*[-*+]\s+/.test(next || '')) || (list === 'ol' && /^\s*\d+[.)]\s+/.test(next || ''));
      if (!nextIsSameList) { closeList(); html.push('<div class="markdown-gap"></div>'); }
    }
    else { closeList(); html.push(`<p>${inlineMarkdown(line)}</p>`); }
  }
  closeList(); if (code) html.push('</code></pre>'); return html.join('').replace(/@@MATHBLOCK(\d+)@@/g, (_, index) => `<div class="math-block">${mathBlocks[Number(index)] || ''}</div>`);
}
function typesetMath(element) {
  const run = () => { if (window.MathJax?.typesetPromise) { window.MathJax.typesetClear?.([element]); window.MathJax.typesetPromise([element]).catch(() => {}); } };
  if (window.MathJax?.typesetPromise) run(); else window.addEventListener('mathjax-ready', run, { once: true });
}

function query() { return new URLSearchParams({ q: $('search').value, benchmark: $('benchmark').value, model: $('model').value, result: $('result').value, page: state.page }); }
async function fetchRecords() {
  $('records').innerHTML = '<div class="empty">正在载入轨迹列表...</div>';
  const response = await fetch(`/api/records?${query()}`); const data = await response.json();
  state.records = data.records; state.total = data.total; state.pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $('match-count').textContent = data.total.toLocaleString(); $('total-count').textContent = `${Object.values(data.benchmarks).reduce((a,b)=>a+b,0).toLocaleString()} TRACES`;
  populateOptions('benchmark', data.benchmarks); populateOptions('model', Object.fromEntries(data.models.map(x => [x, x])));
  renderRecordList();
}
function populateOptions(id, options) { const select = $(id), current = select.value; if (select.options.length > 1) return; Object.keys(options).sort().forEach(key => { const opt = document.createElement('option'); opt.value = key; opt.textContent = id === 'benchmark' ? `${key} (${options[key]})` : key; select.appendChild(opt); }); select.value = current; }
function renderRecordList() {
  $('records').innerHTML = state.records.length ? state.records.map(record => `<article class="record ${state.record?.id === record.id ? 'active':''}" data-id="${escape(record.id)}"><div class="record-top"><span class="record-task">${escape(record.task_id)}</span><span class="reward ${record.benchmark === 'mcpbench' ? 'cont' : record.reward === 1 ? 'success' : 'fail'}">${record.benchmark === 'mcpbench' ? Number(record.reward).toFixed(2) : record.reward === 1 ? 'PASS' : 'FAIL'}</span></div><div class="record-model">${escape(record.source_model)} · pass ${record.pass}</div><div class="record-bottom"><span>${escape(record.benchmark)} / ${escape(record.domain)}</span><span>${record.num_turns} turns · ${record.tool_calls} calls</span></div></article>`).join('') : '<div class="empty">没有符合条件的轨迹。</div>';
  document.querySelectorAll('.record').forEach(node => node.onclick = () => loadRecord(node.dataset.id));
  $('page-label').textContent = `${state.page} / ${state.pages}`; $('prev').disabled = state.page === 1; $('next').disabled = state.page === state.pages;
}
async function loadRecord(id) {
  const response = await fetch(`/api/record?id=${encodeURIComponent(id)}`); state.record = await response.json(); state.selectedEvent = null; state.zoom = 1;
  $('welcome').hidden = true; $('viewer').hidden = false; renderRecordList(); renderViewer();
}
function metric(label, value, tone = '') { return `<span class="metric ${tone}">${label} <b>${escape(value)}</b></span>`; }
function evaluationSummary(record, trace, events) {
  const detail = record.eval_details || {}; const failed = record.benchmark !== 'mcpbench' && record.reward !== 1;
  const result = { verdict: record.benchmark === 'mcpbench' ? `任务完成评分 ${Number(record.reward).toFixed(2)} / 10` : failed ? '任务评测未通过' : '任务评测通过', reasons: [] };
  if (trace.error) result.reasons.push(`运行错误：${trace.error}`);
  if (record.benchmark === 'tau2bench') {
    const info = detail.reward_info || {}; const breakdown = Object.entries(info.reward_breakdown || {}).map(([key, value]) => `${key} ${value}`).join(' · ');
    if (breakdown) result.reasons.push(`评分构成：${breakdown}`);
    const actionFails = (info.action_checks || []).filter(check => !check.action_match).length;
    const communication = (info.communicate_checks || []).filter(check => !check.met).map(check => check.justification).filter(Boolean);
    if (actionFails) result.reasons.push(`未满足 ${actionFails} 项预期操作`);
    if (info.db_check && !info.db_check.db_match) result.reasons.push('最终数据库状态未匹配');
    result.reasons.push(...communication.slice(0, 2));
  } else if (record.benchmark === 'swebench') {
    result.reasons.push(`Resolved: ${detail.resolved ?? 'unknown'} · Tests passed: ${detail.test_passed ?? 'unknown'} · Status: ${detail.status ?? 'unknown'}`);
    if (detail.report) result.reasons.push(`Patch applied: ${detail.report.patch_successfully_applied ?? 'unknown'} · Report resolved: ${detail.report.resolved ?? 'unknown'}`);
    if (detail.note) result.reasons.push(clip(detail.note, 240));
    if (failed && detail.test_output) result.reasons.push(`测试输出：${clip(detail.test_output, 240)}`);
  } else if (record.benchmark === 'terminalbench') {
    result.reasons.push(`Tests passed: ${detail.test_passed ?? 'unknown'} · Status: ${detail.status ?? 'unknown'}`);
    if (detail.note) result.reasons.push(clip(detail.note, 240));
    if (failed && detail.test_output) result.reasons.push(`测试输出：${clip(detail.test_output, 240)}`);
  } else if (record.benchmark === 'mathhay') {
    result.reasons.push(`预测答案：${detail.predicted_answer} · 标准答案：${detail.golden_answer} · 数值匹配：${detail.numerical_match}`);
    if (detail.llm_judge) result.reasons.push(`评测器判断：${detail.llm_judge}`);
  } else if (record.benchmark === 'search') {
    result.reasons.push(`Score: ${detail.score ?? record.reward} · 搜索次数：${detail['search count'] ?? 'unknown'} · 对话轮数：${detail.turns ?? events.length}`);
    if (failed && detail.answer) result.reasons.push(`模型答案：${clip(detail.answer, 240)}`);
  } else if (record.benchmark === 'mcpbench') {
    const score = detail.evaluation || {};
    result.reasons.push(`Task fulfillment ${score.task_fulfillment ?? 'unknown'} · Grounding ${score.grounding ?? 'unknown'} · Tool selection ${score.tool_selection_score ?? 'unknown'}`);
    result.reasons.push(`参数准确度 ${score.parameter_accuracy ?? 'unknown'} · 执行成功率 ${score.execution_success_rate ?? 'unknown'} · 有效工具名率 ${score.valid_tool_name_rate ?? 'unknown'}`);
    const rationale = [score.task_fulfillment_reasoning, score.grounding_reasoning, score.tool_appropriateness_reasoning, score.parameter_accuracy_reasoning].filter(Boolean);
    result.reasons.push(...rationale.slice(0, 2).map(reason => clip(reason, 240)));
  }
  if (!result.reasons.length) result.reasons.push(`共 ${events.length} 条消息，${record.messages.reduce((n, message) => n + (message.tool_calls?.length || 0), 0)} 次工具调用`);
  return result;
}
function openAiSettings(afterSave = null) {
  const modal = document.createElement('div'); modal.className = 'compare-modal';
  modal.innerHTML = `<form class="compare-dialog ai-dialog" aria-labelledby="ai-settings-title"><div class="compare-dialog-head"><div><span class="eyebrow">OPENAI-COMPATIBLE PROVIDER</span><h2 id="ai-settings-title">AI 设置</h2><p>配置仅保留在当前浏览器会话；API Key 不会被保存到磁盘。</p></div><button class="modal-close" type="button" aria-label="关闭">×</button></div><div class="ai-form"><label>Base URL<input class="form-input" name="base_url" type="url" required placeholder="https://your-provider.example/v1" value="${escape(state.ai.base_url)}"></label><label>API Key<input class="form-input" name="api_key" type="password" autocomplete="off" placeholder="${state.ai.api_key ? '已在本会话配置，留空则保留' : 'sk-...'}"></label><label>Model<input class="form-input" name="model" type="text" required placeholder="gpt-4.1-mini" value="${escape(state.ai.model)}"></label><p class="ai-privacy">点击分析时，会向该地址发送当前轨迹的长度受控摘要、工具交互和评测结果，用于生成失败原因分析。</p></div><div class="compare-dialog-foot"><span>支持 <code>/v1/chat/completions</code> 协议</span><div><button class="modal-cancel" type="button">取消</button><button class="compare-confirm" type="submit">保存设置</button></div></div></form>`;
  const close = () => modal.remove(); modal.querySelector('.modal-close').onclick = close; modal.querySelector('.modal-cancel').onclick = close;
  modal.querySelector('form').onsubmit = event => { event.preventDefault(); const form = new FormData(event.currentTarget); const base_url = String(form.get('base_url') || '').trim(); const model = String(form.get('model') || '').trim(); const api_key = String(form.get('api_key') || '').trim() || state.ai.api_key; if (!base_url || !model || !api_key) return; state.ai = { base_url, model, api_key }; sessionStorage.setItem('traceExplorer.aiBaseUrl', base_url); sessionStorage.setItem('traceExplorer.aiModel', model); close(); if (typeof afterSave === 'function') afterSave(); };
  document.body.appendChild(modal);
}
async function analyzeCurrentTrajectory() {
  if (!state.record) return;
  if (!state.ai.base_url || !state.ai.model || !state.ai.api_key) return openAiSettings(analyzeCurrentTrajectory);
  const recordId = state.record.id, cacheKey = aiAnalysisKey(state.record);
  const cached = state.aiAnalyses.get(cacheKey);
  if (cached) return showAiAnalysis(cached, true);
  let request = state.aiAnalysisRequests.get(cacheKey);
  if (!request) {
    request = fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record_id: recordId, config: state.ai }) })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '分析请求失败'); state.aiAnalyses.set(cacheKey, data); return data; })
      .finally(() => state.aiAnalysisRequests.delete(cacheKey));
    state.aiAnalysisRequests.set(cacheKey, request);
  }
  openAiAnalysisLoading(state.ai.model, state.aiAnalysisRequests.has(cacheKey) && request ? '正在基于轨迹、工具结果和评测数据生成分析...' : '正在分析轨迹...');
  try {
    const data = await request;
    if (state.record?.id === recordId && aiAnalysisKey(state.record) === cacheKey) showAiAnalysis(data);
  } catch (error) {
    if (state.record?.id === recordId) openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI EVALUATION ANALYSIS</span><h3>分析未完成</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div></div><section class="detail-section"><p class="analysis-error">${escape(error.message)}</p></section>`);
  }
}
function aiAnalysisKey(record) { return [record.id, state.ai.base_url, state.ai.model].join('\u0000'); }
function openAiAnalysisLoading(model, text) { openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI EVALUATION ANALYSIS</span><h3>正在分析轨迹</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${escape(model)} · 正在调用已配置的服务</div></div><section class="detail-section"><div class="analysis-loading">${escape(text)}</div></section>`); }
function showAiAnalysis(data, cached = false) { openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI EVALUATION ANALYSIS</span><h3>AI 评测分析</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${escape(data.model)} · 基于已保存的轨迹和评测结果${cached ? ' · 本次会话缓存' : ''}</div></div><section class="detail-section"><h4>分析结果</h4><div class="markdown-body">${renderMarkdown(data.analysis)}</div></section>`); }
function renderViewer() {
  const r = state.record, trace = r.trace_meta?.trace || {}, score = r.benchmark === 'mcpbench' ? `${Number(r.reward).toFixed(2)} / 10` : r.reward === 1 ? 'PASS' : 'FAIL';
  $('rec-benchmark').textContent = r.benchmark; $('rec-domain').textContent = r.domain; $('rec-task').textContent = r.task_id; $('record-title').textContent = `${r.source_model} · pass ${r.pass}`; $('record-id').textContent = r.id;
  $('metrics').innerHTML = [metric('REWARD', score), metric('MESSAGES', r.num_turns), metric('TOOL CALLS', r.messages.reduce((n,m) => n + (m.tool_calls?.length || 0), 0)), trace.duration != null ? metric('DURATION', `${Number(trace.duration).toFixed(1)}s`) : '', trace.total_tokens ? metric('TOKENS', Number(trace.total_tokens).toLocaleString()) : '', metric('4 PASSES', r.has_all_4_passes ? 'COMPLETE' : `${r.num_passes_available} AVAILABLE`)].join('');
  const calls = new Map(); r.messages.forEach((m, i) => (m.tool_calls || []).forEach(c => calls.set(c.id, { ...c, messageIndex: i }))); 
  const events = r.messages.map((m, index) => ({ message: m, index, kind: eventKind(m), lane: laneFor(m), sourceCall: m.role === 'tool' ? calls.get(m.tool_call_id) : null })); state.events = events;
  $('event-count').textContent = `${events.length} 条消息`;
  $('timeline').style.gridTemplateRows = `repeat(${events.length}, max-content)`;
  $('timeline').innerHTML = events.map(e => { const m = e.message; const toolNames = (m.tool_calls || []).map(c => c.function?.name || 'tool').join(', '); const title = m.role === 'tool' ? (m.name || e.sourceCall?.function?.name || 'tool result') : m.role === 'assistant' && toolNames ? '工具调用' : ({system:'系统提示',user:'用户任务',assistant:'Agent 回应'}[m.role] || m.role); const preview = m.role === 'tool' ? m.content : (m.content || (toolNames ? `Calls: ${toolNames}` : '无文本内容')); return `<div class="event kind-${e.kind}" style="--lane:${e.lane};grid-row:${e.index + 1}" data-event="${e.index}"><button class="event-card" type="button"><div class="event-kind"><span><i class="event-dot"></i>${escape(m.role.toUpperCase())}</span><span class="event-index">#${e.index + 1}</span></div><div class="event-title">${escape(title)}</div><p class="event-preview">${escape(clip(preview))}</p>${toolNames ? `<div class="call-pill">${escape(toolNames)}</div>` : ''}${m.role === 'tool' && e.sourceCall ? `<div class="tool-link">↖ reply to #${e.sourceCall.messageIndex + 1}</div>` : ''}</button></div>`; }).join('');
  document.querySelectorAll('.event').forEach(node => node.onclick = () => selectEvent(Number(node.dataset.event)));
  const evaluation = evaluationSummary(r, trace, events);
  $('outcome').innerHTML = `<div class="outcome-main">${escape(evaluation.verdict)}</div><ul class="outcome-reasons">${evaluation.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul>`; $('zoom-label').textContent = '100%'; $('timeline').style.transform = 'scale(1)';
  renderDetailEmpty();
}
function selectEvent(index) { state.selectedEvent = index; document.querySelectorAll('.event').forEach(node => node.classList.toggle('selected', Number(node.dataset.event) === index)); const e = state.events[index], m = e.message; const fields = [{label:'消息内容',value:m.content || '(无文本内容)'}]; if (m.tool_calls?.length) fields.push({label:'工具调用',value:pretty(m.tool_calls)}); if (m.role === 'tool') fields.push({label:'调用关联',value:pretty({ tool_call_id:m.tool_call_id, tool_name:m.name || e.sourceCall?.function?.name || null, originating_message:e.sourceCall?.messageIndex != null ? e.sourceCall.messageIndex + 1 : null })});
  const traceStep = (state.record.trace_meta?.trace?.steps || []).find(step => step.content === m.content); if (traceStep) fields.push({label:'运行时步骤',value:pretty(traceStep)});
  openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">STEP ${index + 1} / ${state.events.length}</span><h3>${escape(m.role === 'assistant' ? 'Agent 消息' : m.role === 'tool' ? '工具结果' : m.role === 'user' ? '用户输入' : '系统提示')}</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${escape(m.name || '')}${m.tool_call_id ? ` · ${escape(m.tool_call_id)}` : ''}</div></div>${fields.map(f => `<section class="detail-section"><h4>${f.label}</h4><pre>${escape(f.value)}</pre></section>`).join('')}`);
}
function openDetail(content) { $('app').classList.add('detail-open'); $('detail-content').innerHTML = content; $('detail-content').querySelector('.detail-close')?.addEventListener('click', renderDetailEmpty); typesetMath($('detail')); }
function renderDetailEmpty() { state.selectedEvent = null; $('app').classList.remove('detail-open'); document.querySelectorAll('.event').forEach(node => node.classList.remove('selected')); $('detail-content').innerHTML = '<div class="detail-empty"><div class="detail-symbol">↗</div><h3>步骤详情</h3><p>选择时间线上的节点查看内容。</p></div>'; }
function showEval() { const r = state.record; openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">EVALUATION</span><h3>完整评测数据</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${escape(r.benchmark)} · ${escape(r.task_id)}</div></div><section class="detail-section"><h4>eval_details</h4><pre>${escape(pretty(r.eval_details || {}))}</pre></section><section class="detail-section"><h4>trace_meta</h4><pre>${escape(pretty(r.trace_meta || {}))}</pre></section>`); }
function setZoom(next) { state.zoom = Math.max(.65, Math.min(1.55, next)); $('timeline').style.transform = `scale(${state.zoom})`; $('zoom-label').textContent = `${Math.round(state.zoom*100)}%`; }
function exportSvg() { const r = state.record, events = state.events; const height = 135 + events.length * 72, width = 1120; const colors = {system:'#6b5b9d',user:'#226a9e',assistant:'#167d76',tool:'#a4591d'}; const esc = value => String(value ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); const nodes = events.map((e, i) => { const x = [50, 405, 760][e.lane - 1], y = 100 + i * 72, text = clip(e.message.role === 'tool' ? (e.message.name || 'tool result') : e.message.content || (e.message.tool_calls?.[0]?.function?.name || 'empty'), 54); return `<line x1="${x+14}" y1="${y+42}" x2="${x+14}" y2="${y+72}" stroke="#c6d3d0"/><rect x="${x}" y="${y}" width="310" height="46" fill="#fff" stroke="${colors[e.kind]}"/><circle cx="${x+15}" cy="${y+15}" r="5" fill="${colors[e.kind]}"/><text x="${x+28}" y="${y+19}" font-family="monospace" font-size="10" fill="#5c6a6d">#${i+1} ${esc(e.message.role.toUpperCase())}</text><text x="${x+15}" y="${y+36}" font-family="sans-serif" font-size="11" fill="#17262d">${esc(text)}</text>`; }).join(''); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f7f8f6"/><text x="50" y="31" font-family="sans-serif" font-size="18" font-weight="600" fill="#17262d">${esc(r.id)}</text><text x="50" y="55" font-family="monospace" font-size="11" fill="#66767b">reward: ${esc(r.reward)} · ${events.length} messages · ${r.source_model}</text><text x="50" y="83" font-family="monospace" font-size="10" fill="#66767b">CONTEXT</text><text x="405" y="83" font-family="monospace" font-size="10" fill="#66767b">AGENT</text><text x="760" y="83" font-family="monospace" font-size="10" fill="#66767b">TOOLS / ENVIRONMENT</text>${nodes}</svg>`; const blob = new Blob([svg],{type:'image/svg+xml'}), a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${r.id}.svg`; a.click(); URL.revokeObjectURL(a.href); }
function taskQuery(record) { return new URLSearchParams({ benchmark: record.benchmark, domain: record.domain, task_id: record.task_id }); }
function scoreLabel(record) { return record.benchmark === 'mcpbench' ? `${Number(record.reward).toFixed(2)} / 10` : record.reward === 1 ? 'PASS' : 'FAIL'; }
function signature(message) {
  if (!message) return 'missing';
  const tools = (message.tool_calls || []).map(call => call.function?.name || '').join(',');
  const text = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${message.role}|${tools}|${text}`;
}
function eventLabel(message) {
  if (!message) return '该轨迹在此结束';
  const tools = (message.tool_calls || []).map(call => call.function?.name || '').join(', ');
  if (message.role === 'tool') return message.name || '工具结果';
  if (tools) return `调用 ${tools}`;
  return { system: '系统提示', user: '用户输入', assistant: 'Agent 回应' }[message.role] || message.role;
}
async function openComparePicker() {
  const button = $('compare-task'); button.disabled = true; button.textContent = '载入中...';
  try {
    const response = await fetch(`/api/task-traces?${taskQuery(state.record)}`); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法加载同任务轨迹');
    state.taskTraces = data.traces;
    const sameModel = data.traces.filter(trace => trace.source_model === state.record.source_model);
    state.compareSelection = new Set((sameModel.length > 1 ? sameModel : [state.record]).map(trace => trace.id));
    renderComparePicker();
  } catch (error) { window.alert(error.message); }
  finally { button.disabled = false; button.innerHTML = '⇄ <span>对比本任务</span>'; }
}
function renderComparePicker() {
  const selected = state.compareSelection;
  const rows = state.taskTraces.map(trace => `<label class="compare-choice"><input type="checkbox" value="${escape(trace.id)}" ${selected.has(trace.id) ? 'checked' : ''}><span class="choice-model">${escape(trace.source_model)}</span><span>pass ${trace.pass}</span><span class="choice-reward ${trace.benchmark === 'mcpbench' ? 'continuous' : trace.reward === 1 ? 'success' : 'failure'}">${escape(scoreLabel(trace))}</span><span>${trace.num_turns} 条消息</span></label>`).join('');
  const modal = document.createElement('div'); modal.className = 'compare-modal'; modal.innerHTML = `<div class="compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-picker-title"><div class="compare-dialog-head"><div><span class="eyebrow">TRAJECTORY OVERLAY</span><h2 id="compare-picker-title">选择同任务轨迹</h2><p>${escape(state.record.benchmark)} / ${escape(state.record.domain)} · ${escape(state.record.task_id)}</p></div><button class="modal-close" type="button" aria-label="关闭">×</button></div><div class="compare-selector-note">该任务共 ${state.taskTraces.length} 条轨迹。默认选中当前模型的全部 pass；可勾选任意组合。</div><div class="compare-choice-list">${rows}</div><div class="compare-dialog-foot"><span id="selection-count">已选择 ${selected.size} 条</span><div><button class="modal-cancel" type="button">取消</button><button class="compare-confirm" type="button" ${selected.size < 2 ? 'disabled' : ''}>生成对比图</button></div></div></div>`;
  const close = () => modal.remove(); modal.querySelector('.modal-close').onclick = close; modal.querySelector('.modal-cancel').onclick = close;
  modal.querySelectorAll('input').forEach(input => input.onchange = () => { input.checked ? selected.add(input.value) : selected.delete(input.value); modal.querySelector('#selection-count').textContent = `已选择 ${selected.size} 条`; modal.querySelector('.compare-confirm').disabled = selected.size < 2; });
  modal.querySelector('.compare-confirm').onclick = async () => { close(); await buildComparison([...selected]); };
  document.body.appendChild(modal);
}
async function buildComparison(ids) {
  const view = $('compare-view'); $('viewer').hidden = true; view.hidden = false; view.innerHTML = '<div class="compare-loading">正在载入所选轨迹...</div>'; renderDetailEmpty();
  const records = await Promise.all(ids.map(async id => { const response = await fetch(`/api/record?id=${encodeURIComponent(id)}`); if (!response.ok) throw new Error('读取轨迹失败'); return response.json(); }));
  state.comparedRecords = records; renderComparison(records);
}
function renderComparison(records) {
  const maxSteps = Math.max(...records.map(record => record.messages.length));
  const firstDiff = Array.from({ length: maxSteps }, (_, index) => index).find(index => new Set(records.map(record => signature(record.messages[index]))).size > 1);
  const differences = Array.from({ length: maxSteps }, (_, index) => new Set(records.map(record => signature(record.messages[index]))).size > 1);
  const stepScale = Array.from({ length: maxSteps }, (_, index) => `<span class="compare-scale-step ${differences[index] ? 'is-different' : ''}">#${index + 1}${differences[index] ? ' Δ' : ''}</span>`).join('');
  const lanes = records.map((record, traceIndex) => {
    const firstTraceDiff = differences.findIndex((different, index) => different && signature(record.messages[index]) !== signature(records[0].messages[index]));
    const cards = Array.from({ length: maxSteps }, (_, index) => { const message = record.messages[index]; const differing = differences[index]; return message ? `<button type="button" class="compare-event ${differing ? 'is-different' : ''} kind-${eventKind(message)}" data-compare-trace="${traceIndex}" data-compare-step="${index}"><span class="compare-event-role">${escape(message.role.toUpperCase())}</span><strong>${escape(eventLabel(message))}</strong><small>${escape(clip(message.role === 'tool' ? message.content : message.content || (message.tool_calls?.map(call => call.function?.name).join(', ') || ''), 120))}</small></button>` : `<div class="compare-missing ${differing ? 'is-different' : ''}">此处结束</div>`; }).join('');
    return `<div class="compare-lane" style="grid-template-columns:220px repeat(${maxSteps}, minmax(185px, 1fr));"><div class="compare-lane-head trace-color-${traceIndex % 6}"><span>${escape(record.source_model)}</span><b>pass ${record.pass}</b><small class="${record.benchmark === 'mcpbench' ? 'continuous' : record.reward === 1 ? 'success' : 'failure'}">${escape(scoreLabel(record))} · ${record.num_turns} 条消息</small><em>${firstTraceDiff < 0 ? '与基准轨迹一致' : `首处分歧：第 ${firstTraceDiff + 1} 步`}</em></div>${cards}</div>`;
  }).join('');
  const canAnalyzePair = records.length === 2;
  $('compare-view').innerHTML = `<section class="compare-header"><div><span class="eyebrow">TRAJECTORY OVERLAY</span><h2>${escape(records[0].benchmark)} / ${escape(records[0].domain)} / ${escape(records[0].task_id)}</h2><p>已显示 ${records.length} 条选中轨迹 · 每条各占一行 · ${maxSteps} 个消息步骤 · ${firstDiff == null ? '所选消息完全一致' : `首处分歧：第 ${firstDiff + 1} 步`}</p></div><div class="compare-actions"><button id="ai-compare" class="compare-ai" type="button" ${canAnalyzePair ? '' : 'disabled'} title="${canAnalyzePair ? '分析两条轨迹的首次分歧、关键分歧与结果差异' : 'AI 对比分析需要恰好选择两条轨迹'}">AI 分析差异</button><button id="edit-comparison" type="button">调整选择</button><button id="close-comparison" type="button">返回单轨迹</button></div></section><section class="compare-legend"><span><i class="legend-dot same"></i>一致步骤</span><span><i class="legend-dot difference"></i>差异步骤</span><span>每一行都是一条已选轨迹；红色边框表示角色、工具调用、内容摘要或结束位置不同</span></section><div class="compare-scroll"><div class="compare-lanes" style="grid-template-columns:220px repeat(${maxSteps}, minmax(185px, 1fr));"><div class="compare-lane-scale">TRAJECTORY / STEP</div>${stepScale}${lanes}</div></div>`;
  $('ai-compare').onclick = analyzeComparison; $('edit-comparison').onclick = renderComparePicker; $('close-comparison').onclick = closeComparison;
  document.querySelectorAll('.compare-event').forEach(node => node.onclick = () => selectComparisonEvent(records[Number(node.dataset.compareTrace)], Number(node.dataset.compareStep)));
}
function closeComparison() { $('compare-view').hidden = true; $('viewer').hidden = false; renderDetailEmpty(); }
function comparisonAnalysisKey(records) { return [[...records.map(record => record.id)].sort().join(','), state.ai.base_url, state.ai.model].join('\u0000'); }
async function analyzeComparison() {
  const records = state.comparedRecords || [];
  if (records.length !== 2) return;
  if (!state.ai.base_url || !state.ai.model || !state.ai.api_key) return openAiSettings(analyzeComparison);
  const key = comparisonAnalysisKey(records), recordIds = records.map(record => record.id);
  const cached = state.comparisonAnalyses.get(key);
  if (cached) return showComparisonAnalysis(cached, records, true);
  let request = state.comparisonAnalysisRequests.get(key);
  if (!request) {
    request = fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analysis_type: 'comparison', record_ids: recordIds, config: state.ai }) })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || '对比分析请求失败'); state.comparisonAnalyses.set(key, data); return data; })
      .finally(() => state.comparisonAnalysisRequests.delete(key));
    state.comparisonAnalysisRequests.set(key, request);
  }
  openComparisonAnalysisLoading(records);
  try {
    const data = await request;
    if (comparisonAnalysisKey(state.comparedRecords || []) === key) showComparisonAnalysis(data, records);
  } catch (error) {
    if (comparisonAnalysisKey(state.comparedRecords || []) === key) openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI TRAJECTORY COMPARISON</span><h3>对比分析未完成</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div></div><section class="detail-section"><p class="analysis-error">${escape(error.message)}</p></section>`);
  }
}
function comparisonMeta(records) { return `${escape(records[0].source_model)} · pass ${escape(records[0].pass)} vs ${escape(records[1].source_model)} · pass ${escape(records[1].pass)}`; }
function openComparisonAnalysisLoading(records) { openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI TRAJECTORY COMPARISON</span><h3>正在分析两条轨迹</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${comparisonMeta(records)} · ${escape(state.ai.model)}</div></div><section class="detail-section"><div class="analysis-loading">正在定位首次分歧、影响最终结果的关键步骤及两者之间的因果关系...</div></section>`); }
function showComparisonAnalysis(data, records, cached = false) { openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">AI TRAJECTORY COMPARISON</span><h3>AI 对比分析</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${comparisonMeta(records)} · ${escape(data.model)}${cached ? ' · 本次会话缓存' : ''}</div></div><section class="detail-section"><h4>差异与因果分析</h4><div class="markdown-body">${renderMarkdown(data.analysis)}</div></section>`); }
function selectComparisonEvent(record, index) {
  const message = record.messages[index]; const fields = [{ label: '消息内容', value: message.content || '(无文本内容)' }];
  if (message.tool_calls?.length) fields.push({ label: '工具调用', value: pretty(message.tool_calls) });
  if (message.role === 'tool') fields.push({ label: '工具关联', value: pretty({ tool_call_id: message.tool_call_id, name: message.name || null }) });
  openDetail(`<div class="detail-head"><div class="detail-title-row"><div><span class="eyebrow">COMPARE · STEP ${index + 1}</span><h3>${escape(record.source_model)} · pass ${record.pass}</h3></div><button class="detail-close" type="button" title="关闭详情" aria-label="关闭详情">×</button></div><div class="detail-meta">${escape(message.role)} · ${escape(record.id)}</div></div>${fields.map(field => `<section class="detail-section"><h4>${field.label}</h4><pre>${escape(field.value)}</pre></section>`).join('')}`);
}
function enablePanelResizing() {
  const bind = (handle, panel, property, storageKey, side, minimum, maximum, activeClass) => {
    let width = Number(sessionStorage.getItem(storageKey));
    if (Number.isFinite(width) && width > 0) $('app').style.setProperty(property, `${Math.max(minimum, Math.min(maximum, width))}px`);
    else width = Math.round(panel.getBoundingClientRect().width);
    handle.addEventListener('pointerdown', event => {
      if (window.innerWidth <= 980) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId); document.body.classList.add('is-resizing-panel');
      const move = pointer => {
        const bounds = panel.getBoundingClientRect(); const next = side === 'left' ? pointer.clientX - bounds.left : bounds.right - pointer.clientX;
        width = Math.max(minimum, Math.min(maximum, Math.round(next))); $('app').style.setProperty(property, `${width}px`);
      };
      const end = pointer => { if (pointer.pointerId !== event.pointerId) return; sessionStorage.setItem(storageKey, String(width)); handle.releasePointerCapture?.(pointer.pointerId); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); document.body.classList.remove('is-resizing-panel'); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
  };
  bind($('sidebar-resizer'), $('sidebar-resizer').parentElement, '--sidebar-width', 'traceExplorer.sidebarWidth', 'left', 220, 420);
  bind($('detail-resizer'), $('detail'), '--detail-width', 'traceExplorer.detailWidth', 'right', 280, 620);
}
['benchmark','model','result'].forEach(id => $(id).onchange = () => {state.page=1;fetchRecords()}); let timer; $('search').oninput = () => {clearTimeout(timer);timer=setTimeout(()=>{state.page=1;fetchRecords()},250)}; $('prev').onclick=()=>{if(state.page>1){state.page--;fetchRecords()}}; $('next').onclick=()=>{if(state.page<state.pages){state.page++;fetchRecords()}}; $('zoom-in').onclick=()=>setZoom(state.zoom+.15); $('zoom-out').onclick=()=>setZoom(state.zoom-.15); $('fit').onclick=()=>setZoom(1); $('show-eval').onclick=showEval; $('ai-analyze').onclick=analyzeCurrentTrajectory; $('ai-settings').onclick=()=>openAiSettings(false); $('export').onclick=exportSvg; $('compare-task').onclick=openComparePicker; document.addEventListener('keydown', event => { if (event.key === 'Escape') renderDetailEmpty(); }); enablePanelResizing();
fetchRecords();
