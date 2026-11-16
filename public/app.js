(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    status: null,
    chatHistory: [],
    gallery: [],
    currentImage: null,
    // 量測引擎狀態
    measureEnabled: true,
    edgeSnapEnabled: true,
    selectClearMode: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
    isPanning: false,
    panStart: { x: 0, y: 0 },
    imgElement: null,
    offscreenCanvas: document.createElement('canvas'),
    offscreenImageData: null,
    pendingPoint: null,
    measures: [],
    selectedMeasureIdx: -1,
    hoveredMeasureIdx: -1,
    draggingLabelIdx: -1,
    dragOffset: { x: 0, y: 0 },
    mouseCanvasPos: null
  };

  function showToast(msg, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.style.borderColor = isError ? '#f43f5e' : '#38bdf8';
    el.style.display = 'block';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.style.display = 'none';
    }, 3400);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSimpleMarkdown(text) {
    let html = escapeHtml(text || '');
    // code blocks
    html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code}</code></pre>`;
    });
    // inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // line breaks
    html = html.replace(/\n/g, '<br />');
    return html;
  }

  // ==================== 頁籤切換 ====================
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
      if (target === 'studio') {
        resizeCanvas();
      }
      if (target === 'hub') {
        loadHubInitialData();
      }
    });
  });

  // ==================== 狀態與模型管理 ====================
  async function refreshStatus() {
    try {
      const resp = await fetch('/api/status');
      const data = await resp.json();
      state.status = data;

      const hw = data.hardware || {};
      $('hwSubtitle').textContent = `${hw.cpu || 'CPU'} | ${hw.totalRamGB || '?'} GB RAM | 內建 ${data.toolsCount} 大自主工具`;
      $('modelsDirPill').textContent = data.ollamaModelsDir || 'D:\\OllamaModels';

      const dot = $('ollamaDot');
      const pillText = $('ollamaPillText');
      if (data.ollama && data.ollama.online) {
        dot.className = 'dot online';
        const cnt = (data.ollama.models || []).length;
        pillText.textContent = `Ollama 在線 (${cnt} 模型)`;
      } else {
        dot.className = 'dot warn';
        pillText.textContent = 'Ollama 未連線';
      }

      const geminiOpt = $('geminiOption');
      if (data.geminiAvailable) {
        geminiOpt.disabled = false;
        geminiOpt.textContent = '☁️ Gemini 雲端協同腦 (已就緒)';
      } else {
        geminiOpt.disabled = true;
        geminiOpt.textContent = '☁️ Gemini 雲端協同腦 (未偵測到 Key)';
      }

      const localSdOpt = document.querySelector('#imgEngine option[value="local-sd"]');
      if (localSdOpt && data.localSd) {
        localSdOpt.textContent = data.localSd.installed
          ? '🏠 Local SD-LCM (本機無限制・零浮水印・已就緒)'
          : `🏠 Local SD-LCM (安裝中 ${data.localSd.modelSizeMB || 0} MB...)`;
      }

      syncModelDropdown();
      renderOllamaModelsList();
    } catch (err) {
      showToast(`狀態讀取失敗: ${err.message}`, true);
    }
  }

  function syncModelDropdown() {
    const provider = $('providerSelect').value;
    const sel = $('modelSelect');
    const prev = sel.value;
    sel.innerHTML = '';

    if (provider === 'gemini') {
      ['gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest'].forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      });
      return;
    }

    const models = (state.status && state.status.ollama && state.status.ollama.models) || [];
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'qwen2.5:3b';
      opt.textContent = 'qwen2.5:3b (尚未拉取)';
      sel.appendChild(opt);
    } else {
      models.forEach((m) => {
        const sizeGB = m.size ? ` (${(m.size / (1024 ** 3)).toFixed(1)} GB)` : '';
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = `${m.name}${sizeGB}`;
        sel.appendChild(opt);
      });
      if (prev && models.some((m) => m.name === prev)) {
        sel.value = prev;
      }
    }
  }

  $('providerSelect').addEventListener('change', () => {
    syncModelDropdown();
    refreshContextStatus();
  });

  // ==================== 上下文 Token 水位 & 80% 自動摘要壓縮 ====================
  function renderDiffHtml(diffPreview) {
    return String(diffPreview || '')
      .split(/\r?\n/)
      .map((line) => {
        if (line.startsWith('+')) {
          return `<span class="diff-add">${escapeHtml(line)}</span>`;
        }
        return `<span class="diff-meta">${escapeHtml(line)}</span>`;
      })
      .join('');
  }

  function renderContextStatus(ctx) {
    if (!ctx) return;
    const textEl = $('ctxGaugeText');
    const fillEl = $('ctxGaugeBarFill');
    const budgetSel = $('ctxBudgetSelect');
    const capsuleEl = $('contextCapsuleBanner');

    const total = Number(ctx.totalTokens) || 0;
    const budget = Number(ctx.budgetTokens) || 4096;
    const pct = Number(ctx.usagePct) || 0;
    const threshold = Number(ctx.thresholdPct) || 80;
    const sysTok = Number(ctx.systemBaseTokens) || 0;
    const chatTok = (Number(ctx.historyTokens) || 0) + (Number(ctx.summaryTokens) || 0);

    if (textEl) {
      const tag = pct >= threshold ? '警戒・即將自動壓縮' : pct >= 60 ? '偏高' : '充裕';
      textEl.textContent = `${total.toLocaleString()} / ${budget.toLocaleString()} tok (${pct}%・${tag}｜系統 ${sysTok.toLocaleString()} + 對話 ${chatTok.toLocaleString()})`;
    }
    if (fillEl) {
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      fillEl.className = `ctx-bar-fill${pct >= threshold ? ' danger' : pct >= 60 ? ' warn' : ''}`;
    }
    if (budgetSel && Array.from(budgetSel.options).some((o) => Number(o.value) === budget)) {
      budgetSel.value = String(budget);
    }

    if (capsuleEl) {
      if (ctx.rollingSummary && ctx.rollingSummary.trim()) {
        const wasOpen = capsuleEl.dataset.open === '1';
        capsuleEl.style.display = 'block';
        capsuleEl.innerHTML = `
          <div class="context-capsule-header" id="ctxCapsuleToggle">
            <span>📦 前情提要記憶膠囊（已壓縮 ${ctx.compactedCount || 0} 則早期對話・節省 ${(ctx.savedTokens || 0).toLocaleString()} tokens）</span>
            <span style="font-size:0.8rem;color:#7dd3fc;">${wasOpen ? '▲ 收合摘要' : '▼ 展開檢視'}</span>
          </div>
          <div class="context-capsule-body" style="display:${wasOpen ? 'block' : 'none'};">${escapeHtml(ctx.rollingSummary)}</div>
        `;
        $('ctxCapsuleToggle').addEventListener('click', () => {
          const nextOpen = capsuleEl.dataset.open !== '1';
          capsuleEl.dataset.open = nextOpen ? '1' : '0';
          renderContextStatus(ctx);
        });
      } else {
        capsuleEl.style.display = 'none';
        capsuleEl.innerHTML = '';
      }
    }
  }

  async function refreshContextStatus() {
    try {
      const provider = $('providerSelect').value || 'ollama';
      const resp = await fetch(`/api/chat/context-status?provider=${encodeURIComponent(provider)}`);
      const data = await resp.json();
      if (data.success) renderContextStatus(data);
    } catch {
      // ignore
    }
  }

  $('ctxBudgetSelect').addEventListener('change', async () => {
    const budgetTokens = Number($('ctxBudgetSelect').value) || 4096;
    try {
      const resp = await fetch('/api/chat/context-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetTokens })
      });
      const data = await resp.json();
      if (data.success) {
        renderContextStatus(data);
        showToast(`已切換上下文預算為 ${budgetTokens.toLocaleString()} tokens (80% 自動壓縮)`);
      }
    } catch (err) {
      showToast(`設定更新失敗: ${err.message}`, true);
    }
  });

  $('btnCompactNow').addEventListener('click', async () => {
    const btn = $('btnCompactNow');
    btn.disabled = true;
    btn.textContent = '🗜️ 壓縮整理中...';
    try {
      const resp = await fetch('/api/chat/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: $('providerSelect').value,
          model: $('modelSelect').value,
          keepRecentMessages: 4,
          force: true
        })
      });
      const data = await resp.json();
      if (!data.success) {
        showToast(data.error || '壓縮失敗', true);
      } else if (!data.compacted) {
        showToast(data.reason || '目前對話無需壓縮');
      } else {
        state.chatHistory = Array.isArray(data.history) ? data.history : [];
        $('chatMessages').innerHTML = '';
        state.chatHistory.forEach(appendChatMessage);
        if (data.contextStatus) renderContextStatus(data.contextStatus);
        showToast(`✅ 已壓縮 ${data.compactedMessagesCount} 則早期對話，節省 ${data.savedTokensDelta} tokens！`);
      }
    } catch (err) {
      showToast(`壓縮錯誤: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🗜️ 立即壓縮上下文';
    }
  });

  function renderOllamaModelsList() {
    const box = $('ollamaModelsList');
    const ollama = state.status && state.status.ollama;
    if (!ollama || !ollama.online) {
      box.innerHTML = '<div class="tag-warn">Ollama 背景服務尚未啟動（請透過「啟動系統(無黑窗背景執行).vbs」或執行 ollama serve）。</div>';
      return;
    }
    const models = ollama.models || [];
    if (models.length === 0) {
      box.innerHTML = '<div class="tag-warn">D:\\OllamaModels 目前尚無已安裝模型，請下方點擊拉取 qwen2.5:3b。</div>';
      return;
    }
    box.innerHTML = `
      <table class="data-table">
        <thead><tr><th>模型名稱</th><th>大小</th><th>參數規模</th></tr></thead>
        <tbody>
          ${models.map((m) => `
            <tr>
              <td><strong>${escapeHtml(m.name)}</strong></td>
              <td>${m.size ? (m.size / (1024 ** 3)).toFixed(2) + ' GB' : '-'}</td>
              <td>${escapeHtml((m.details && m.details.parameter_size) || '-')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ==================== 對話與 ReAct 戰情室 ====================
  function appendChatMessage(msg) {
    const container = $('chatMessages');
    const row = document.createElement('div');
    row.className = `msg-row ${msg.role}`;

    let traceHtml = '';
    if (Array.isArray(msg.trace) && msg.trace.length > 0) {
      traceHtml = `
        <div class="trace-box">
          <div style="font-weight:700;color:#7dd3fc;margin-bottom:6px;">🧠 Agent 思考與自主工具調用軌跡 (${msg.trace.length} 步)</div>
          ${msg.trace.map((t) => `
            <div class="trace-item">
              <span class="trace-badge">#${t.step} ${escapeHtml(t.toolName)}</span>
              <span class="${t.success ? 'tag-ok' : 'tag-warn'}">${t.success ? '成功' : '警告'} (${t.durationMs}ms)</span>
              <div style="color:#94a3b8;font-family:Consolas,monospace;font-size:0.8rem;margin-top:3px;">參數: ${escapeHtml(JSON.stringify(t.args))}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    let imgsHtml = '';
    if (Array.isArray(msg.generatedImages) && msg.generatedImages.length > 0) {
      imgsHtml = `
        <div class="chat-generated-imgs">
          ${msg.generatedImages.map((img) => `
            <div class="chat-img-card">
              <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.prompt)}" />
              <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;">
                <span style="font-size:0.8rem;color:#94a3b8;">${escapeHtml(img.engine)}</span>
                <button class="btn btn-sm btn-primary btn-send-to-studio" data-url="${escapeHtml(img.url)}">📏 帶入幾何量測工坊</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    let learnedHtml = '';
    if (msg.learned && msg.learned.pending && msg.learned.proposal) {
      const prop = msg.learned.proposal;
      learnedHtml = `
        <div class="chat-proposal-card" data-proposal-id="${escapeHtml(prop.id)}">
          <div style="font-weight:700;color:#fcd34d;font-size:0.87rem;">
            📝 [成長治理] 偵測到待核准記憶提案 → 目標：<code>${escapeHtml(prop.file)}</code>
          </div>
          <div class="diff-block">${renderDiffHtml(prop.diffPreview)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
            <input class="input chat-prop-input" style="flex:1;min-width:200px;padding:5px 9px;font-size:0.84rem;" value="${escapeHtml(prop.ruleText)}" />
            <button class="btn btn-primary btn-sm btn-chat-prop-approve">✅ 核准寫入</button>
            <button class="btn btn-danger btn-sm btn-chat-prop-reject">✖ 略過</button>
          </div>
        </div>
      `;
    } else if (msg.learned && msg.learned.learned) {
      learnedHtml = `<div style="margin-top:10px;padding:7px 10px;border-radius:8px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);color:#6ee7b7;font-size:0.86rem;">🧬 <strong>[自主學習] 已自動寫入 ${escapeHtml(msg.learned.file)}：</strong>${escapeHtml(msg.learned.ruleText)}</div>`;
    }

    const metaText = msg.role === 'assistant' && msg.model
      ? `<div class="msg-meta"><span>大腦: ${escapeHtml(msg.provider)} / ${escapeHtml(msg.model)}</span>${msg.elapsedMs ? `<span>耗時: ${(msg.elapsedMs / 1000).toFixed(1)} 秒</span>` : ''}</div>`
      : '';

    row.innerHTML = `
      <div class="msg-bubble md-body">
        ${traceHtml}
        <div>${renderSimpleMarkdown(msg.content)}</div>
        ${imgsHtml}
        ${learnedHtml}
      </div>
      ${metaText}
    `;

    row.querySelectorAll('.btn-send-to-studio').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelector('.nav-tab[data-tab="studio"]').click();
        loadImageIntoCanvas(b.dataset.url);
      });
    });

    const propCard = row.querySelector('.chat-proposal-card');
    if (propCard) {
      const propId = propCard.dataset.proposalId;
      const inputEl = propCard.querySelector('.chat-prop-input');
      propCard.querySelector('.btn-chat-prop-approve').addEventListener('click', async () => {
        const customRuleText = inputEl ? inputEl.value.trim() : '';
        const resp = await fetch(`/api/memory/proposals/${encodeURIComponent(propId)}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customRuleText })
        });
        const data = await resp.json();
        if (data.success) {
          propCard.style.borderColor = 'rgba(16,185,129,0.5)';
          propCard.style.background = 'rgba(16,185,129,0.12)';
          propCard.innerHTML = `<div style="color:#6ee7b7;font-size:0.86rem;">✅ 已核准寫入記憶：<strong>${escapeHtml(customRuleText)}</strong>（可於「記憶鐵律」頁籤隨時原子回退）</div>`;
          loadMemory();
          refreshContextStatus();
          showToast('已核准並寫入記憶檔案！');
        } else {
          showToast(data.error || '核准失敗', true);
        }
      });
      propCard.querySelector('.btn-chat-prop-reject').addEventListener('click', async () => {
        const resp = await fetch(`/api/memory/proposals/${encodeURIComponent(propId)}/reject`, { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
          propCard.innerHTML = '<div style="color:#94a3b8;font-size:0.84rem;">✖ 已略過此條記憶學習提案。</div>';
          loadMemory();
        }
      });
    }

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  async function loadChatHistory() {
    try {
      const resp = await fetch('/api/chat/history');
      const data = await resp.json();
      if (data.contextStatus) renderContextStatus(data.contextStatus);
      if (data.success && Array.isArray(data.history) && data.history.length > 0) {
        state.chatHistory = data.history;
        $('chatMessages').innerHTML = '';
        data.history.forEach(appendChatMessage);
      }
    } catch {
      // ignore
    }
  }

  async function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;

    if (/[a-zA-Z]:\\/.test(text) && $('enableToolsChk') && !$('enableToolsChk').checked) {
      $('enableToolsChk').checked = true;
    }

    input.value = '';
    const btn = $('btnSendChat');
    btn.disabled = true;
    btn.textContent = '🧠 思考執行中...';

    appendChatMessage({ role: 'user', content: text });

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: state.chatHistory,
          provider: $('providerSelect').value,
          model: $('modelSelect').value,
          enableTools: $('enableToolsChk').checked
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        appendChatMessage({ role: 'assistant', content: `⚠️ 執行失敗：${data.error || '未知錯誤'}` });
      } else {
        const assistantMsg = {
          role: 'assistant',
          content: data.reply,
          trace: data.trace,
          generatedImages: data.generatedImages,
          learned: data.learned,
          provider: data.provider,
          model: data.model,
          elapsedMs: data.elapsedMs
        };

        if (data.compactionEvent && Array.isArray(data.history)) {
          state.chatHistory = data.history;
          $('chatMessages').innerHTML = '';
          state.chatHistory.forEach(appendChatMessage);
          showToast(`🗜️ 上下文達警戒水位：已自動壓縮 ${data.compactionEvent.compactedMessagesCount} 則早期對話為前情提要膠囊！`);
        } else {
          state.chatHistory.push({ role: 'user', content: text }, assistantMsg);
          appendChatMessage(assistantMsg);
        }

        if (data.contextStatus) {
          renderContextStatus(data.contextStatus);
        } else {
          refreshContextStatus();
        }

        if (data.learned && (data.learned.learned || data.learned.pending)) {
          loadMemory();
        }
        if (data.generatedImages && data.generatedImages.length > 0) {
          refreshGallery();
        }
      }
    } catch (err) {
      appendChatMessage({ role: 'assistant', content: `⚠️ 網路錯誤：${err.message}` });
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 發送指令';
    }
  }

  $('btnSendChat').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  $('btnClearChat').addEventListener('click', async () => {
    const resp = await fetch('/api/chat/history', { method: 'DELETE' });
    const data = await resp.json();
    state.chatHistory = [];
    $('chatMessages').innerHTML = '';
    if (data.contextStatus) renderContextStatus(data.contextStatus);
    showToast('對話歷史與前情提要膠囊已清空');
  });

  document.querySelectorAll('.quick-prompts .quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if ($('enableToolsChk')) $('enableToolsChk').checked = true;
      $('chatInput').value = chip.dataset.prompt;
      sendChat();
    });
  });

  // ==================== 圖片創建工坊 & 圖庫 ====================
  async function refreshGallery(autoLoadFirst = false) {
    try {
      const resp = await fetch('/api/image/gallery');
      const data = await resp.json();
      state.gallery = data.items || [];
      const grid = $('galleryGrid');
      if (state.gallery.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1;color:#94a3b8;font-size:0.9rem;">尚未生成圖片，請於上方輸入描述創建圖片。</div>';
        return;
      }

      grid.innerHTML = state.gallery.map((item) => `
        <div class="gallery-thumb ${state.currentImage === item.url ? 'active' : ''}" data-url="${escapeHtml(item.url)}">
          <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.prompt)}" />
          <button class="gallery-thumb-del" data-filename="${escapeHtml(item.filename)}" title="刪除圖片">✖</button>
        </div>
      `).join('');

      grid.querySelectorAll('.gallery-thumb').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('gallery-thumb-del')) return;
          loadImageIntoCanvas(card.dataset.url);
        });
      });

      grid.querySelectorAll('.gallery-thumb-del').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/image/gallery/${encodeURIComponent(btn.dataset.filename)}`, { method: 'DELETE' });
          refreshGallery();
        });
      });

      if (autoLoadFirst && !state.currentImage && state.gallery[0]) {
        loadImageIntoCanvas(state.gallery[0].url);
      }
    } catch {
      // ignore
    }
  }

  $('btnRefreshGallery').addEventListener('click', () => refreshGallery());

  function setImgAgentStatus(text, tone = 'ok') {
    const badge = $('imgAgentStateBadge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = tone === 'warn' ? 'tag-warn' : tone === 'muted' ? 'tag-muted' : 'tag-ok';
  }

  function appendImgAgentLog(htmlText, type = 'ai') {
    const log = $('imgAgentFeedbackLog');
    if (!log) return null;
    const div = document.createElement('div');
    div.className = `img-agent-msg ${type}`;
    div.innerHTML = htmlText;
    log.appendChild(div);
    while (log.children.length > 30) {
      log.removeChild(log.firstChild);
    }
    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function triggerGenerateImage() {
    const prompt = $('imgPrompt').value.trim();
    if (!prompt) {
      showToast('請輸入畫面描述 (Prompt)', true);
      appendImgAgentLog('⚠️ 請先在上方「畫面描述 Prompt」輸入內容，或直接於下方輸入您的想法請我代為構思！', 'error');
      return;
    }
    const [w, h] = $('imgSize').value.split('x').map(Number);
    const engine = $('imgEngine').value;
    const style = $('imgStyle').value;
    const btn = $('btnGenImage');
    btn.disabled = true;
    btn.textContent = '🎨 正在生成圖片...';

    const t0 = Date.now();
    setImgAgentStatus('生成中 0s', 'warn');
    const engineLabel = engine === 'local-sd'
      ? '本機 DreamShaper-7 LCM (離線零浮水印)'
      : engine === 'local-svg'
        ? '本機 Local SVG 向量引擎'
        : `雲端 ${engine.toUpperCase()} (含去浮水印裁切)`;
    const progressEl = appendImgAgentLog(
      `⏳ 已接收創作任務「<strong>${escapeHtml(prompt.slice(0, 60))}${prompt.length > 60 ? '...' : ''}</strong>」<br/>🔄 正在轉譯提示詞並呼叫 <code>${escapeHtml(engineLabel)}</code>... (已耗時 0s)`,
      'system'
    );

    const timer = setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      setImgAgentStatus(`生成中 ${sec}s`, 'warn');
      if (progressEl) {
        progressEl.innerHTML = `⏳ 正在使用 <code>${escapeHtml(engineLabel)}</code> 執行計算與去浮水印處理...（已耗時 <strong>${sec}s</strong>${engine === 'local-sd' ? '，CPU 離線運算約 2~3 分鐘' : ''}）`;
      }
    }, 1000);

    try {
      const resp = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          engine,
          style,
          width: w,
          height: h,
          seed: $('imgSeed').value ? Number($('imgSeed').value) : undefined,
          provider: $('providerSelect').value,
          llmModel: $('modelSelect').value,
          privateMode: Boolean($('imgPrivateModeChk') && $('imgPrivateModeChk').checked)
        })
      });
      const data = await resp.json();
      clearInterval(timer);
      const totalSec = Math.round(((Date.now() - t0) / 1000) * 10) / 10;

      if (!data.success) {
        setImgAgentStatus('生成異常', 'warn');
        showToast(data.error || '圖片生成失敗', true);
        if (progressEl) progressEl.remove();
        if (Array.isArray(data.agentFeedback)) {
          data.agentFeedback.forEach((line) => appendImgAgentLog(escapeHtml(line), 'ai'));
        }
        appendImgAgentLog(`❌ 錯誤原因：${escapeHtml(data.error || '未知錯誤')}`, 'error');
      } else {
        setImgAgentStatus(`完成 (${totalSec}s)`, 'ok');
        if (progressEl) progressEl.remove();
        if (Array.isArray(data.agentFeedback) && data.agentFeedback.length > 0) {
          appendImgAgentLog(data.agentFeedback.map((line) => escapeHtml(line)).join('<br/>'), 'ai');
        } else {
          appendImgAgentLog(`✅ 已生成圖片 <code>${escapeHtml(data.filename)}</code>（${data.width}×${data.height}，耗時 ${totalSec}s）。`, 'ai');
        }
        appendImgAgentLog('💡 想調整構圖、光線或風格嗎？請在下方對話框告訴我修改要求！', 'system');

        if (data.fallbackUsed) {
          showToast(`雲端端點暫不可達 (${data.cloudError})，已自動產出本機離線向量圖！`);
        } else {
          showToast(`圖片自由創建成功！（${totalSec}s・無浮水印）`);
        }
        await refreshGallery();
        loadImageIntoCanvas(data.url);
      }
    } catch (err) {
      clearInterval(timer);
      setImgAgentStatus('連線錯誤', 'warn');
      if (progressEl) progressEl.remove();
      appendImgAgentLog(`❌ 請求異常：${escapeHtml(err.message)}`, 'error');
      showToast(`生圖錯誤: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ 立即自由創建圖片';
    }
  }

  async function runImgAgentAssist(instruction, autoGenerate = false) {
    const curPrompt = $('imgPrompt').value.trim();
    const userText = (instruction || '').trim();
    if (!curPrompt && !userText) {
      showToast('請先輸入描述或想跟 AI 討論的改圖內容', true);
      return;
    }

    appendImgAgentLog(`🙋 您：${escapeHtml(userText || '請幫我潤飾並強化目前的畫面描述')}`, 'user');
    setImgAgentStatus('AI 思考中...', 'warn');
    const optBtn = $('btnImgAgentOptimize');
    const sendBtn = $('btnImgAgentSend');
    const genBtn = $('btnImgAgentSendAndGen');
    optBtn.disabled = true;
    sendBtn.disabled = true;
    genBtn.disabled = true;

    try {
      const resp = await fetch('/api/image/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: curPrompt,
          instruction: userText,
          style: $('imgStyle').value,
          engine: $('imgEngine').value,
          provider: $('providerSelect').value,
          llmModel: $('modelSelect').value,
          privateMode: Boolean($('imgPrivateModeChk') && $('imgPrivateModeChk').checked)
        })
      });
      const data = await resp.json();
      if (!data.success) {
        setImgAgentStatus('溝通失敗', 'warn');
        appendImgAgentLog(`❌ AI 回應失敗：${escapeHtml(data.error || '未知錯誤')}`, 'error');
        return;
      }

      if (data.refinedPrompt) {
        const promptBox = $('imgPrompt');
        promptBox.value = data.refinedPrompt;
        promptBox.style.borderColor = '#10b981';
        setTimeout(() => { promptBox.style.borderColor = ''; }, 1600);
      }

      let msgHtml = `🤖 <strong>AI Co-Pilot：</strong>${escapeHtml(data.reply || '已更新上方畫面描述。')}`;
      if (data.englishPrompt) {
        msgHtml += `<br/><span style="color:#7dd3fc;">🔤 建議繪圖詞：<code>${escapeHtml(data.englishPrompt)}</code></span>`;
      }
      if (data.engineAdvice) {
        msgHtml += `<br/><span style="color:#94a3b8;">💡 ${escapeHtml(data.engineAdvice)}</span>`;
      }
      if (data.learnedTaste) {
        msgHtml += `<br/><span style="color:#6ee7b7;">🧬 已自主累積視覺偏好：${escapeHtml(data.learnedTaste)}</span>`;
      }
      appendImgAgentLog(msgHtml, 'ai');
      setImgAgentStatus('Prompt 已更新', 'ok');

      if (autoGenerate) {
        await triggerGenerateImage();
      }
    } catch (err) {
      setImgAgentStatus('錯誤', 'warn');
      appendImgAgentLog(`❌ 協作錯誤：${escapeHtml(err.message)}`, 'error');
    } finally {
      optBtn.disabled = false;
      sendBtn.disabled = false;
      genBtn.disabled = false;
    }
  }

  $('btnGenImage').addEventListener('click', triggerGenerateImage);

  $('btnImgAgentOptimize').addEventListener('click', () => {
    runImgAgentAssist('請根據目前的畫面描述，補強光影、景深、構圖與質感細節，讓圖片更有專業質感。', false);
  });

  $('btnImgAgentSend').addEventListener('click', () => {
    const val = $('imgAgentChatInput').value.trim();
    if (!val) {
      showToast('請輸入想跟 AI 溝通的改圖要求', true);
      return;
    }
    $('imgAgentChatInput').value = '';
    runImgAgentAssist(val, false);
  });

  $('btnImgAgentSendAndGen').addEventListener('click', () => {
    const val = $('imgAgentChatInput').value.trim();
    $('imgAgentChatInput').value = '';
    runImgAgentAssist(val || '請強化細節並直接重新生圖', true);
  });

  $('imgAgentChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('btnImgAgentSend').click();
    }
  });

  async function clearStudioHistory() {
    const btn = $('btnClearImgHistory');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/image/history', { method: 'DELETE' });
      const data = await resp.json();
      if (!data.success) {
        showToast(data.error || '清除失敗', true);
        return;
      }
      if ($('imgPrompt')) $('imgPrompt').value = '';
      if ($('imgAgentChatInput')) $('imgAgentChatInput').value = '';
      const log = $('imgAgentFeedbackLog');
      if (log) {
        log.innerHTML = '<div class="img-agent-msg system">🛡️ 已清除所有改圖歷史對話、上方畫面描述 Prompt、AI 生圖偏好記憶（image_taste.json）與圖庫提示詞紀錄，您的隱私對話不會被保留。</div>';
      }
      setImgAgentStatus('隱私已清除', 'ok');
      await refreshGallery();
      await loadMemory();
      showToast('🗑️ 已清除圖片工坊歷史對話與所有隱私提示詞紀錄！');
    } catch (err) {
      showToast(`清除失敗: ${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if ($('btnClearImgHistory')) {
    $('btnClearImgHistory').addEventListener('click', clearStudioHistory);
  }

  // ==================== 工業級 Sobel 幾何切線尺寸量測器 ====================
  const canvas = $('measureCanvas');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const stage = $('canvasStage');
    const rect = stage.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
      drawMeasureCanvas();
    }
  }

  window.addEventListener('resize', resizeCanvas);

  function loadImageIntoCanvas(url) {
    state.currentImage = url;
    $('btnDownloadCanvasImg').href = url;
    document.querySelectorAll('.gallery-thumb').forEach((el) => {
      el.classList.toggle('active', el.dataset.url === url);
    });

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      state.imgElement = img;
      state.measures = [];
      state.pendingPoint = null;
      state.selectedMeasureIdx = -1;

      const stageRect = $('canvasStage').getBoundingClientRect();
      const cw = stageRect.width || 900;
      const ch = stageRect.height || 540;
      const fitScale = Math.min((cw - 40) / img.naturalWidth, (ch - 40) / img.naturalHeight, 1.5);
      state.zoom = Math.max(0.2, fitScale);
      state.pan = { x: 0, y: 0 };

      // 準備離屏 Sobel 像素採樣畫布
      state.offscreenCanvas.width = img.naturalWidth;
      state.offscreenCanvas.height = img.naturalHeight;
      const octx = state.offscreenCanvas.getContext('2d', { willReadFrequently: true });
      octx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
      try {
        state.offscreenImageData = octx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
      } catch {
        state.offscreenImageData = null;
      }

      resizeCanvas();
      updateZoomReadout();
    };
    img.src = url;
  }

  function updateZoomReadout() {
    $('zoomReadout').textContent = `縮放: ${Math.round(state.zoom * 100)}%`;
  }

  function screenToImageLocal(sx, sy) {
    const cx = canvas.width / 2 + state.pan.x;
    const cy = canvas.height / 2 + state.pan.y;
    return {
      x: (sx - cx) / state.zoom,
      y: (sy - cy) / state.zoom
    };
  }

  function imageLocalToScreen(lx, ly) {
    const cx = canvas.width / 2 + state.pan.x;
    const cy = canvas.height / 2 + state.pan.y;
    return {
      x: cx + lx * state.zoom,
      y: cy + ly * state.zoom
    };
  }

  function getPixelGray(px, py, data, width, height) {
    if (px < 0 || px >= width || py < 0 || py >= height) return 0;
    const idx = (py * width + px) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  function findDefectEdge(localX, localY) {
    if (!state.offscreenImageData || !state.edgeSnapEnabled || !state.imgElement) return null;
    const w = state.offscreenCanvas.width;
    const h = state.offscreenCanvas.height;
    const data = state.offscreenImageData.data;

    const imgX = Math.round(localX + w / 2);
    const imgY = Math.round(localY + h / 2);
    const radius = Math.max(6, Math.min(16, Math.round(10 / state.zoom)));

    let maxScore = 0;
    let bestX = imgX;
    let bestY = imgY;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = imgX + dx;
        const py = imgY + dy;
        if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;

        const gx = getPixelGray(px + 1, py, data, w, h) - getPixelGray(px - 1, py, data, w, h);
        const gy = getPixelGray(px, py + 1, data, w, h) - getPixelGray(px, py - 1, data, w, h);
        const grad = Math.abs(gx) + Math.abs(gy);
        const score = grad / (1 + dist * 0.18);
        if (score > maxScore) {
          maxScore = score;
          bestX = px;
          bestY = py;
        }
      }
    }

    if (maxScore > 24) {
      return { x: bestX - w / 2, y: bestY - h / 2, grad: maxScore };
    }
    return null;
  }

  /**
   * 3x3 Sobel 梯度算子計算幾何切線角度 (垂直於明暗梯度法向)
   */
  function getEdgeTangentAngle(localX, localY) {
    if (!state.offscreenImageData || !state.imgElement) return 0;
    const w = state.offscreenCanvas.width;
    const h = state.offscreenCanvas.height;
    const data = state.offscreenImageData.data;
    const rx = Math.round(localX + w / 2);
    const ry = Math.round(localY + h / 2);
    if (rx < 1 || rx >= w - 1 || ry < 1 || ry >= h - 1) return 0;

    const p00 = getPixelGray(rx - 1, ry - 1, data, w, h);
    const p01 = getPixelGray(rx,     ry - 1, data, w, h);
    const p02 = getPixelGray(rx + 1, ry - 1, data, w, h);
    const p10 = getPixelGray(rx - 1, ry,     data, w, h);
    const p12 = getPixelGray(rx + 1, ry,     data, w, h);
    const p20 = getPixelGray(rx - 1, ry + 1, data, w, h);
    const p21 = getPixelGray(rx,     ry + 1, data, w, h);
    const p22 = getPixelGray(rx + 1, ry + 1, data, w, h);

    const gx = (p02 + 2 * p12 + p22) - (p00 + 2 * p10 + p20);
    const gy = (p20 + 2 * p21 + p22) - (p00 + 2 * p01 + p02);
    const gradLen = Math.hypot(gx, gy);
    if (gradLen > 10) {
      return Math.atan2(gx, -gy);
    }
    return 0;
  }

  function formatMeasureDistance(p1, p2) {
    const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const umPerPx = Number($('scaleUmInput').value) || 1.80;
    const unit = $('unitSelect').value;
    if (unit === 'px') return `${pxDist.toFixed(1)} px`;
    const um = pxDist * umPerPx;
    if (unit === 'mm') return `${(um / 1000).toFixed(3)} mm`;
    return `${um.toFixed(1)} μm`;
  }

  function computeLabelRect(m) {
    const s1 = imageLocalToScreen(m.p1.x, m.p1.y);
    const s2 = imageLocalToScreen(m.p2.x, m.p2.y);
    const dx = s2.x - s1.x;
    const dy = s2.y - s1.y;
    const len = Math.hypot(dx, dy) || 1;
    // 預設沿標線側邊保持 16px 安全淨空
    const nx = -dy / len;
    const ny = dx / len;
    const offX = m.labelOffset ? m.labelOffset.x : nx * 24;
    const offY = m.labelOffset ? m.labelOffset.y : ny * 24;
    const cx = (s1.x + s2.x) / 2 + offX;
    const cy = (s1.y + s2.y) / 2 + offY;
    const text = formatMeasureDistance(m.p1, m.p2);
    ctx.font = 'bold 14px Consolas, "Microsoft JhengHei", sans-serif';
    const tw = ctx.measureText(text).width;
    const w = tw + 24;
    const h = 28;
    return {
      cx,
      cy,
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      text,
      delCx: cx + w / 2 - 4,
      delCy: cy - h / 2 + 4
    };
  }

  function drawTangentEndpoint(sx, sy, angleRad, color, tickLen = 14) {
    const tx = Math.cos(angleRad) * tickLen;
    const ty = Math.sin(angleRad) * tickLen;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(sx - tx, sy - ty);
    ctx.lineTo(sx + tx, sy + ty);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawMeasureCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 繪製暗色工程網格背景
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!state.imgElement) {
      ctx.fillStyle = '#64748b';
      ctx.font = '18px "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('請從左側自由創建圖片，或點擊本機圖庫載入圖片以進行幾何切線量測', canvas.width / 2, canvas.height / 2);
      return;
    }

    const img = state.imgElement;
    const cx = canvas.width / 2 + state.pan.x;
    const cy = canvas.height / 2 + state.pan.y;
    const drawW = img.naturalWidth * state.zoom;
    const drawH = img.naturalHeight * state.zoom;

    ctx.save();
    ctx.imageSmoothingEnabled = state.zoom < 2.2;
    ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();

    // 繪製已完成的量測標記
    state.measures.forEach((m, idx) => {
      const s1 = imageLocalToScreen(m.p1.x, m.p1.y);
      const s2 = imageLocalToScreen(m.p2.x, m.p2.y);
      const isSelected = idx === state.selectedMeasureIdx;
      const isHovered = idx === state.hoveredMeasureIdx;
      const lineColor = (state.selectClearMode && isHovered)
        ? '#f43f5e'
        : (isSelected ? '#fbbf24' : '#38bdf8');

      // 主量測線
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = isSelected ? 2.6 : 2;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
      ctx.restore();

      // 兩端幾何切線 / 垂直端線
      const measAngle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      const perpAngle = measAngle + Math.PI / 2;
      const a1 = typeof m.p1.tangentAngle === 'number' && m.p1.hasEdge ? m.p1.tangentAngle : perpAngle;
      const a2 = typeof m.p2.tangentAngle === 'number' && m.p2.hasEdge ? m.p2.tangentAngle : perpAngle;
      drawTangentEndpoint(s1.x, s1.y, a1, lineColor);
      drawTangentEndpoint(s2.x, s2.y, a2, lineColor);

      // 安全淨空尺寸框 (可自由拖曳)
      const rect = computeLabelRect(m);
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo((s1.x + s2.x) / 2, (s1.y + s2.y) / 2);
      ctx.lineTo(rect.cx, rect.cy);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 7);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 14px Consolas, "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rect.text, rect.cx, rect.cy);

      if (isHovered || isSelected) {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(rect.delCx, rect.delCy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('×', rect.delCx, rect.delCy + 0.5);
      }
      ctx.restore();
    });

    // 繪製第一點與拉線動態切向對齊導引虛線
    if (state.pendingPoint) {
      const s1 = imageLocalToScreen(state.pendingPoint.x, state.pendingPoint.y);
      const t1 = state.pendingPoint.hasEdge ? state.pendingPoint.tangentAngle : 0;
      drawTangentEndpoint(s1.x, s1.y, t1, '#fbbf24', 16);

      if (state.mouseCanvasPos) {
        const localM = screenToImageLocal(state.mouseCanvasPos.x, state.mouseCanvasPos.y);
        const snapM = findDefectEdge(localM.x, localM.y);
        const targetLocal = snapM ? { x: snapM.x, y: snapM.y } : localM;
        const s2 = imageLocalToScreen(targetLocal.x, targetLocal.y);

        const measAngle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
        const perpAngle = measAngle + Math.PI / 2;

        ctx.save();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.restore();

        // 動態端線與垂直對齊感
        drawTangentEndpoint(s2.x, s2.y, perpAngle, 'rgba(251, 191, 36, 0.9)', 14);
        if (!state.pendingPoint.hasEdge) {
          drawTangentEndpoint(s1.x, s1.y, perpAngle, 'rgba(251, 191, 36, 0.9)', 14);
        }

        // 即時預覽數值
        const previewDist = formatMeasureDistance(state.pendingPoint, targetLocal);
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = '#fbbf24';
        ctx.beginPath();
        ctx.roundRect(s2.x + 16, s2.y - 28, ctx.measureText(previewDist).width + 26, 26, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fde68a';
        ctx.font = 'bold 13px Consolas, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(previewDist, s2.x + 24, s2.y - 15);
        ctx.restore();
      }
    }

    // 繪製中心鏤空半透明細線導引游標（去干擾規範）
    if (state.measureEnabled && state.mouseCanvasPos && !state.isPanning) {
      const mx = state.mouseCanvasPos.x;
      const my = state.mouseCanvasPos.y;
      const localM = screenToImageLocal(mx, my);
      const snap = findDefectEdge(localM.x, localM.y);
      const disp = snap ? imageLocalToScreen(snap.x, snap.y) : { x: mx, y: my };

      ctx.save();
      ctx.strokeStyle = snap ? 'rgba(56, 189, 248, 0.88)' : 'rgba(251, 191, 36, 0.72)';
      ctx.lineWidth = 1.2;
      const gap = 7;
      const arm = 22;
      ctx.beginPath();
      ctx.moveTo(disp.x - arm, disp.y); ctx.lineTo(disp.x - gap, disp.y);
      ctx.moveTo(disp.x + gap, disp.y); ctx.lineTo(disp.x + arm, disp.y);
      ctx.moveTo(disp.x, disp.y - arm); ctx.lineTo(disp.x, disp.y - gap);
      ctx.moveTo(disp.x, disp.y + gap); ctx.lineTo(disp.x, disp.y + arm);
      ctx.stroke();
      ctx.restore();
    }
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    if (!state.imgElement) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    state.zoom = Math.max(0.15, Math.min(12, state.zoom * factor));
    updateZoomReadout();
    drawMeasureCanvas();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.button === 2 || e.button === 1 || !state.measureEnabled) {
      state.isPanning = true;
      state.panStart = { x: sx - state.pan.x, y: sy - state.pan.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    // 檢查是否點擊某個尺寸框的 ✖ 刪除鈕或框內（拖曳/清除）
    for (let i = state.measures.length - 1; i >= 0; i--) {
      const m = state.measures[i];
      const box = computeLabelRect(m);
      if (Math.hypot(sx - box.delCx, sy - box.delCy) <= 11) {
        state.measures.splice(i, 1);
        state.selectedMeasureIdx = -1;
        drawMeasureCanvas();
        return;
      }
      if (sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
        if (state.selectClearMode) {
          state.measures.splice(i, 1);
          state.selectedMeasureIdx = -1;
          drawMeasureCanvas();
          return;
        }
        state.selectedMeasureIdx = i;
        state.draggingLabelIdx = i;
        state.dragOffset = { x: sx - box.cx, y: sy - box.cy };
        drawMeasureCanvas();
        return;
      }
    }

    if (state.selectClearMode && state.hoveredMeasureIdx >= 0) {
      state.measures.splice(state.hoveredMeasureIdx, 1);
      state.hoveredMeasureIdx = -1;
      drawMeasureCanvas();
      return;
    }

    if (!state.imgElement) return;
    const localM = screenToImageLocal(sx, sy);
    const snap = findDefectEdge(localM.x, localM.y);
    const finalPt = snap ? { x: snap.x, y: snap.y } : localM;
    const tangentAngle = getEdgeTangentAngle(finalPt.x, finalPt.y);
    const pt = {
      x: finalPt.x,
      y: finalPt.y,
      tangentAngle,
      hasEdge: Boolean(snap) || Math.abs(tangentAngle) > 0.001
    };

    if (!state.pendingPoint) {
      state.pendingPoint = pt;
    } else {
      state.measures.push({
        p1: state.pendingPoint,
        p2: pt,
        labelOffset: null
      });
      state.selectedMeasureIdx = state.measures.length - 1;
      state.pendingPoint = null;
    }
    drawMeasureCanvas();
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    state.mouseCanvasPos = { x: sx, y: sy };

    if (state.isPanning) {
      state.pan.x = sx - state.panStart.x;
      state.pan.y = sy - state.panStart.y;
      drawMeasureCanvas();
      return;
    }

    if (state.draggingLabelIdx >= 0) {
      const m = state.measures[state.draggingLabelIdx];
      const s1 = imageLocalToScreen(m.p1.x, m.p1.y);
      const s2 = imageLocalToScreen(m.p2.x, m.p2.y);
      const midX = (s1.x + s2.x) / 2;
      const midY = (s1.y + s2.y) / 2;
      m.labelOffset = {
        x: (sx - state.dragOffset.x) - midX,
        y: (sy - state.dragOffset.y) - midY
      };
      drawMeasureCanvas();
      return;
    }

    let hovered = -1;
    for (let i = state.measures.length - 1; i >= 0; i--) {
      const box = computeLabelRect(state.measures[i]);
      if (sx >= box.x - 6 && sx <= box.x + box.w + 10 && sy >= box.y - 10 && sy <= box.y + box.h + 6) {
        hovered = i;
        break;
      }
    }
    state.hoveredMeasureIdx = hovered;
    canvas.style.cursor = hovered >= 0 ? (state.selectClearMode ? 'pointer' : 'move') : (state.measureEnabled ? 'none' : 'grab');
    drawMeasureCanvas();
  });

  window.addEventListener('mouseup', () => {
    state.isPanning = false;
    state.draggingLabelIdx = -1;
    canvas.style.cursor = state.measureEnabled ? 'none' : 'grab';
  });

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key.toLowerCase() === 's') {
      $('btnToggleSnap').click();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedMeasureIdx >= 0) {
      state.measures.splice(state.selectedMeasureIdx, 1);
      state.selectedMeasureIdx = -1;
      drawMeasureCanvas();
    } else if (e.key === 'Escape' && state.pendingPoint) {
      state.pendingPoint = null;
      drawMeasureCanvas();
    }
  });

  $('btnToggleMeasure').addEventListener('click', () => {
    state.measureEnabled = !state.measureEnabled;
    $('btnToggleMeasure').textContent = `📏 幾何切線量測：${state.measureEnabled ? '開啟' : '關閉'}`;
    $('btnToggleMeasure').classList.toggle('btn-primary', state.measureEnabled);
    drawMeasureCanvas();
  });

  $('btnToggleSnap').addEventListener('click', () => {
    state.edgeSnapEnabled = !state.edgeSnapEnabled;
    $('btnToggleSnap').textContent = `🧲 Sobel 自動吸附 (S)：${state.edgeSnapEnabled ? '開啟' : '關閉'}`;
    $('btnToggleSnap').classList.toggle('btn-amber', !state.edgeSnapEnabled);
  });

  $('btnSelectClear').addEventListener('click', () => {
    state.selectClearMode = !state.selectClearMode;
    $('btnSelectClear').textContent = `🗑️ 點選清除：${state.selectClearMode ? '開啟' : '關閉'}`;
    $('btnSelectClear').classList.toggle('btn-danger', state.selectClearMode);
  });

  $('btnClearMeasures').addEventListener('click', () => {
    state.measures = [];
    state.pendingPoint = null;
    state.selectedMeasureIdx = -1;
    drawMeasureCanvas();
  });

  $('btnResetZoom').addEventListener('click', () => {
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    updateZoomReadout();
    drawMeasureCanvas();
  });

  $('scaleUmInput').addEventListener('change', drawMeasureCanvas);
  $('unitSelect').addEventListener('change', drawMeasureCanvas);

  // ==================== 本機專案特定功能中控台 ====================
  let hubLoadedOnce = false;
  async function loadHubInitialData() {
    if (hubLoadedOnce) return;
    hubLoadedOnce = true;
    await Promise.all([
      loadExcelList(),
      scanProjects(),
      loadMesSpc(),
      loadAoiSummary()
    ]);
  }

  $('btnRefreshStatus').addEventListener('click', refreshStatus);

  document.querySelectorAll('.pull-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('pullModelInput').value = btn.dataset.model;
    });
  });

  $('btnPullModel').addEventListener('click', async () => {
    const model = $('pullModelInput').value.trim();
    if (!model) return;
    $('pullProgressText').textContent = `正在排程拉取 ${model} 至 D:\\OllamaModels ...`;
    try {
      const resp = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      const data = await resp.json();
      if (!data.success) {
        $('pullProgressText').textContent = `⚠️ ${data.error}`;
        return;
      }
      const timer = setInterval(async () => {
        const r = await fetch(`/api/ollama/pull/${data.jobId}`);
        const job = await r.json();
        $('pullProgressText').textContent = `[${job.model}] ${job.detail}`;
        if (job.done) {
          clearInterval(timer);
          refreshStatus();
        }
      }, 1500);
    } catch (err) {
      $('pullProgressText').textContent = `⚠️ ${err.message}`;
    }
  });

  async function loadMesSpc() {
    const lot = $('mesLotInput').value.trim();
    const out = $('mesSpcOutput');
    out.textContent = '載入計算中...';
    try {
      const resp = await fetch(`/api/tools/mes-spc?lotNo=${encodeURIComponent(lot)}`);
      const data = await resp.json();
      if (!data.success) {
        out.innerHTML = `<div class="tag-warn">${escapeHtml(data.error)}</div>`;
        return;
      }
      const info = data.info || {};
      const lotsHint = (data.availableLots || []).map((l) => l.lotNo).join(', ');
      out.innerHTML = `
        <div style="margin-bottom:10px;color:#cbd5e1;">
          <strong>批號：</strong><code>${escapeHtml(info.lotNo)}</code> |
          <strong>工單：</strong>${escapeHtml(info.workOrder)} |
          <strong>站別：</strong>${escapeHtml(info.operation)} |
          <strong>品名：</strong>${escapeHtml(info.productName)}
          <div style="font-size:0.82rem;color:#94a3b8;">可用批號快取：${escapeHtml(lotsHint)}</div>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>檢驗項目</th><th>N</th><th>LSL/USL</th><th>X-bar</th><th>Range</th><th>σ</th><th>Ca%</th><th>Cp</th><th>Cpk</th></tr>
            </thead>
            <tbody>
              ${(data.analyzedItems || []).map((it) => {
                const s = it.spc || {};
                const cpkClass = s.cpk >= 1.33 ? 'tag-ok' : 'tag-warn';
                return `
                  <tr>
                    <td>${escapeHtml(it.itemName)}</td>
                    <td>${s.n ?? '-'}</td>
                    <td>${s.lsl ?? '-'} ~ ${s.usl ?? '-'}</td>
                    <td><strong>${s.mean ?? '-'}</strong></td>
                    <td>${s.range ?? '-'}</td>
                    <td>${s.stdDev ?? '-'}</td>
                    <td>${s.caPct ?? '-'}%</td>
                    <td>${s.cp ?? '-'}</td>
                    <td><span class="${cpkClass}">${s.cpk ?? '-'}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      out.innerHTML = `<div class="tag-warn">${escapeHtml(err.message)}</div>`;
    }
  }
  $('btnLoadMesSpc').addEventListener('click', loadMesSpc);

  async function loadExcelList() {
    const resp = await fetch('/api/tools/excel-list');
    const data = await resp.json();
    const sel = $('excelFileSelect');
    sel.innerHTML = (data.files || []).map((f) => `
      <option value="${escapeHtml(f.path)}">[${escapeHtml(f.project)}] ${escapeHtml(f.name)} (${f.sizeKB} KB)</option>
    `).join('');
  }

  $('btnParseExcel').addEventListener('click', async () => {
    const filePath = $('excelFileSelect').value;
    const out = $('excelOutput');
    if (!filePath) return;
    out.textContent = '正在執行 4-Byte 檔頭預檢與 Last-Value 截斷解析...';
    try {
      const resp = await fetch('/api/tools/excel-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, maxRows: 25 })
      });
      const data = await resp.json();
      if (!data.success) {
        out.innerHTML = `<div class="tag-warn">${escapeHtml(data.error)}</div>`;
        return;
      }
      const firstSheetName = Object.keys(data.sheets || {})[0];
      const sheet = data.sheets[firstSheetName];
      const rawMB = sheet && sheet.stats ? (sheet.stats.rawXmlBytes / 1024).toFixed(1) : '?';
      const cutKB = sheet && sheet.stats ? (sheet.stats.truncatedXmlBytes / 1024).toFixed(1) : '?';
      const cols = (sheet && sheet.columns) || [];
      const rows = (sheet && sheet.rows) || [];

      out.innerHTML = `
        <div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
          <span class="tag-ok">4-Byte 檔頭: ${escapeHtml(data.headerHex)} (PK ZIP 合法)</span>
          <span class="tag-ok">解析耗時: ${data.elapsedMs} ms</span>
          <span class="tag-ok">工作表: ${escapeHtml(firstSheetName)} (共 ${sheet ? sheet.totalValidRows : 0} 筆有效列)</span>
          <span style="font-size:0.86rem;color:#94a3b8;">XML 截斷壓縮：${rawMB} KB → ${cutKB} KB</span>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>列</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td>${r._row}</td>
                  ${cols.map((c) => `<td>${escapeHtml(r[c] || '')}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      out.innerHTML = `<div class="tag-warn">${escapeHtml(err.message)}</div>`;
    }
  });

  async function scanProjects() {
    const out = $('projectsOutput');
    out.textContent = '巡檢中...';
    const resp = await fetch('/api/tools/projects');
    const data = await resp.json();
    if (!data.success) {
      out.textContent = data.error;
      return;
    }
    out.innerHTML = `
      <div style="margin-bottom:8px;color:#cbd5e1;">
        共偵測 <strong>${data.totalCount}</strong> 個專案（含 AGENTS.md：${data.withAgentsCount}｜無黑窗 VBS：${data.withVbsCount}｜Git 版控：${data.withGitCount}）
      </div>
      <table class="data-table">
        <thead><tr><th>專案名稱</th><th>技術棧</th><th>AGENTS.md</th><th>Git</th><th>無黑窗 VBS</th><th>服務端口</th></tr></thead>
        <tbody>
          ${data.projects.map((p) => `
            <tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${escapeHtml(p.stack)}</td>
              <td><span class="${p.hasAgents ? 'tag-ok' : 'tag-muted'}">${p.hasAgents ? '✓ 已規範' : '無'}</span></td>
              <td><span class="${p.hasGit ? 'tag-ok' : 'tag-muted'}">${p.hasGit ? '✓ Git' : '無'}</span></td>
              <td><span class="${p.hasVbs ? 'tag-ok' : 'tag-muted'}">${p.hasVbs ? '✓ 無黑窗' : '無'}</span></td>
              <td>${p.port ? `<span class="${p.portActive ? 'tag-ok' : 'tag-warn'}">:${p.port} (${p.portActive ? '運行中' : '待機'})</span>` : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
  $('btnScanProjects').addEventListener('click', scanProjects);

  async function loadAoiSummary() {
    const out = $('aoiOutput');
    const resp = await fetch('/api/tools/aoi');
    const data = await resp.json();
    if (!data.success) {
      out.innerHTML = `<div class="tag-warn">${escapeHtml(data.error)}</div>`;
      return;
    }
    out.innerHTML = `
      <div style="margin-bottom:8px;">總案件：<strong>${data.totalCases}</strong>｜待覆判：<span class="tag-warn">${data.pendingCount}</span>｜已結案：<span class="tag-ok">${data.closedCount}</span></div>
      <table class="data-table">
        <thead><tr><th>案號</th><th>品名 / 盒號</th><th>Issue</th><th>狀態</th><th>KLA 點數</th></tr></thead>
        <tbody>
          ${(data.recentCases || []).map((c) => `
            <tr>
              <td><code>${escapeHtml(c.id)}</code></td>
              <td>${escapeHtml(c.productName)} | ${escapeHtml(c.cassetteSlot)}</td>
              <td>${escapeHtml(c.issue)}</td>
              <td><span class="${c.decision ? 'tag-ok' : 'tag-warn'}">${escapeHtml(c.decision || c.status)}</span></td>
              <td>素${c.coordCounts.rawGlass} / 軟${c.coordCounts.softBake} / 硬${c.coordCounts.hardBake}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
  $('btnLoadAoi').addEventListener('click', loadAoiSummary);

  $('btnOutlookCal').addEventListener('click', async () => {
    const out = $('outlookBrainOutput');
    out.textContent = '正在透過 MAPI 唯讀檢索未來 14 天行程...';
    const resp = await fetch('/api/tools/outlook?mode=calendar&days=14');
    const data = await resp.json();
    if (!data.success) {
      out.innerHTML = `<div class="tag-warn">${escapeHtml(data.error)}</div>`;
      return;
    }
    if (!data.items || data.items.length === 0) {
      out.innerHTML = '<div class="tag-ok">未來 14 天無 Outlook 行事曆排程。</div>';
      return;
    }
    out.innerHTML = `
      <table class="data-table">
        <thead><tr><th>時間</th><th>主旨</th><th>地點</th></tr></thead>
        <tbody>
          ${data.items.map((it) => `<tr><td>${escapeHtml(it.Start)}</td><td>${escapeHtml(it.Subject)}</td><td>${escapeHtml(it.Location || '-')}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
  });

  $('btnSecondbrainLint').addEventListener('click', async () => {
    const out = $('outlookBrainOutput');
    out.textContent = '正在對 Obsidian Secondbrain 執行雙向連結與孤兒筆記健康檢查...';
    const resp = await fetch('/api/tools/secondbrain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lint' })
    });
    const data = await resp.json();
    if (!data.success) {
      out.innerHTML = `<div class="tag-warn">${escapeHtml(data.error)}</div>`;
      return;
    }
    out.innerHTML = `
      <div style="margin-bottom:8px;">
        <span class="tag-ok">總筆記數: ${data.totalNotes}</span>
        <span class="${data.brokenLinksCount ? 'tag-warn' : 'tag-ok'}">斷裂連結: ${data.brokenLinksCount}</span>
        <span class="tag-muted">知識庫未連結筆記 (前25): ${data.knowledgeOrphansCount}</span>
      </div>
      <div style="font-size:0.86rem;color:#cbd5e1;">
        ${(data.brokenLinks || []).slice(0, 10).map((b) => `<div>• <code>${escapeHtml(b.source)}</code> → 缺少 [[${escapeHtml(b.missingTarget)}]]</div>`).join('')}
      </div>
    `;
  });

  // ==================== 記憶編輯器 & 成長治理 (Diff 提案核准 & 原子回退) ====================
  function renderGovernancePanels(ls) {
    if (!ls || !ls.success) return;
    const policySel = $('govPolicySelect');
    if (policySel && ls.policy) {
      policySel.value = ls.policy;
    }

    const badge = $('navPendingBadge');
    const pendingList = Array.isArray(ls.pendingProposals) ? ls.pendingProposals : [];
    const appliedList = Array.isArray(ls.appliedHistory) ? ls.appliedHistory : [];

    if (badge) {
      if (pendingList.length > 0) {
        badge.style.display = 'inline-flex';
        badge.textContent = String(pendingList.length);
      } else {
        badge.style.display = 'none';
      }
    }

    if ($('pendingProposalsCount')) $('pendingProposalsCount').textContent = String(pendingList.length);
    if ($('appliedHistoryCount')) $('appliedHistoryCount').textContent = String(appliedList.length);
    if ($('btnApproveAllProposals')) $('btnApproveAllProposals').disabled = pendingList.length === 0;

    const pendingBox = $('pendingProposalsList');
    if (pendingBox) {
      if (pendingList.length === 0) {
        pendingBox.innerHTML = '<div style="color:#94a3b8;font-size:0.88rem;padding:8px 0;">目前無待審核的 Diff 提案。若為「提案審核模式」，對話糾正或反思總結的新規則會優先送達此處。</div>';
      } else {
        pendingBox.innerHTML = pendingList.map((p) => `
          <div class="gov-item" data-id="${escapeHtml(p.id)}">
            <div class="gov-item-header">
              <span>目標：<code>${escapeHtml(p.file)}</code>｜來源：<span class="tag-muted">${escapeHtml(p.tag || '自主學習')}</span></span>
              <span>${escapeHtml((p.createdAt || '').slice(0, 16).replace('T', ' '))}</span>
            </div>
            ${p.sourceMessage ? `<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:4px;">觸發原句：「${escapeHtml(p.sourceMessage)}」</div>` : ''}
            <div class="diff-block">${renderDiffHtml(p.diffPreview)}</div>
            <div class="gov-item-actions">
              <input class="input gov-edit-input" style="flex:1;min-width:180px;padding:5px 9px;font-size:0.84rem;" value="${escapeHtml(p.ruleText)}" />
              <button class="btn btn-primary btn-sm btn-gov-approve">✅ 核准寫入</button>
              <button class="btn btn-danger btn-sm btn-gov-reject">🗑️ 拒絕</button>
            </div>
          </div>
        `).join('');

        pendingBox.querySelectorAll('.gov-item').forEach((itemEl) => {
          const id = itemEl.dataset.id;
          const editInput = itemEl.querySelector('.gov-edit-input');
          itemEl.querySelector('.btn-gov-approve').addEventListener('click', async () => {
            const customRuleText = editInput ? editInput.value.trim() : '';
            const resp = await fetch(`/api/memory/proposals/${encodeURIComponent(id)}/approve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ customRuleText })
            });
            const data = await resp.json();
            if (data.success) {
              await loadMemory();
              refreshContextStatus();
              showToast('✅ 已核准 Diff 提案並熱套用寫入記憶！');
            } else {
              showToast(data.error || '核准失敗', true);
            }
          });
          itemEl.querySelector('.btn-gov-reject').addEventListener('click', async () => {
            const resp = await fetch(`/api/memory/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
              await loadMemory();
              showToast('已拒絕並移除該提案');
            }
          });
        });
      }
    }

    const appliedBox = $('appliedHistoryList');
    if (appliedBox) {
      if (appliedList.length === 0) {
        appliedBox.innerHTML = '<div style="color:#94a3b8;font-size:0.88rem;padding:8px 0;">尚無近期透過治理系統寫入的記憶紀錄（舊有既定規則與 🔴 鐵律仍安全保留於下方檔案中）。</div>';
      } else {
        appliedBox.innerHTML = appliedList.map((a) => `
          <div class="gov-item" data-id="${escapeHtml(a.id)}">
            <div class="gov-item-header">
              <span>已寫入：<code>${escapeHtml(a.file)}</code>｜<span class="tag-ok">${escapeHtml(a.tag || '自主學習')}</span></span>
              <span>${escapeHtml((a.appliedAt || '').slice(0, 16).replace('T', ' '))}</span>
            </div>
            <div style="font-size:0.88rem;color:#e2e8f0;line-height:1.5;">${escapeHtml(a.entry || a.ruleText)}</div>
            <div class="gov-item-actions">
              <button class="btn btn-amber btn-sm btn-gov-rollback">↩️ 原子回退 (Rollback)</button>
            </div>
          </div>
        `).join('');

        appliedBox.querySelectorAll('.gov-item').forEach((itemEl) => {
          const id = itemEl.dataset.id;
          itemEl.querySelector('.btn-gov-rollback').addEventListener('click', async () => {
            const resp = await fetch(`/api/memory/applied/${encodeURIComponent(id)}/rollback`, { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
              await loadMemory();
              refreshContextStatus();
              showToast('↩️ 已原子回退，精準從記憶檔案撤銷該筆規則！');
            } else {
              showToast(data.error || '回退失敗', true);
            }
          });
        });
      }
    }
  }

  async function loadMemory() {
    const resp = await fetch('/api/memory');
    const data = await resp.json();
    if (data.success && data.files) {
      $('memSoul').value = data.files.SOUL || '';
      $('memUser').value = data.files.USER || '';
      $('memMemory').value = data.files.MEMORY || '';
    }
    try {
      const lsResp = await fetch('/api/memory/governance');
      const ls = await lsResp.json();
      const box = $('learningStatusBox');
      if (box && ls.success) {
        const tasteText = (ls.imageTaste && ls.imageTaste.summaryText) ? ls.imageTaste.summaryText : '尚無累積（生圖或溝通改圖時會自動學習）';
        box.innerHTML = `🛡️ 受保護 🔴 核心鐵律：<strong>${ls.redRuleCount}</strong> 條｜🧬 已寫入學習規則：<strong>${ls.learnedCount}</strong> 條｜📝 待核准提案：<strong>${ls.pendingCount || 0}</strong> 筆｜🎨 審美偏好關鍵字：<code>${escapeHtml(tasteText)}</code>`;
        renderGovernancePanels(ls);
      }
    } catch {
      // ignore
    }
  }

  if ($('govPolicySelect')) {
    $('govPolicySelect').addEventListener('change', async () => {
      const policy = $('govPolicySelect').value;
      const resp = await fetch('/api/memory/governance/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy })
      });
      const data = await resp.json();
      if (data.success) {
        if (data.governance) renderGovernancePanels(data.governance);
        showToast(policy === 'review'
          ? '🟡 已切換為「提案審核模式」：新學習經驗將先產生 Diff 提案待您核准'
          : '🟢 已切換為「自動套用模式」：新學習經驗將直接寫入並保留回退紀錄');
      }
    });
  }

  if ($('btnApproveAllProposals')) {
    $('btnApproveAllProposals').addEventListener('click', async () => {
      const resp = await fetch('/api/memory/proposals/approve-all', { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        await loadMemory();
        refreshContextStatus();
        showToast(`✅ 已一次核准並寫入 ${data.approvedCount || 0} 筆記憶提案！`);
      }
    });
  }

  $('btnAutoLearnNow').addEventListener('click', async () => {
    const btn = $('btnAutoLearnNow');
    btn.disabled = true;
    btn.textContent = '🧠 AI 正在回顧對話並整理提案...';
    try {
      const resp = await fetch('/api/memory/auto-learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: $('providerSelect').value,
          model: $('modelSelect').value
        })
      });
      const data = await resp.json();
      if (!data.success) {
        showToast(data.error || '自主學習總結失敗', true);
      } else {
        await loadMemory();
        refreshContextStatus();
        showToast(data.message || '自主總結完成！');
      }
    } catch (err) {
      showToast(`自主學習錯誤: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ 讓 AI 從近期對話自主總結並學習';
    }
  });

  $('btnReloadMemory').addEventListener('click', loadMemory);
  document.querySelectorAll('.save-mem-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const file = btn.dataset.file;
      const map = { SOUL: 'memSoul', USER: 'memUser', MEMORY: 'memMemory' };
      const content = $(map[file]).value;
      const resp = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content })
      });
      const data = await resp.json();
      if (!data.success) {
        showToast(data.error || '儲存失敗', true);
      } else {
        await loadMemory();
        refreshContextStatus();
        showToast(`${file}.md 已儲存並熱生效！`);
      }
    });
  });

  // ==================== Ollama 每日自主演練與 ollama調效.md 追蹤 ====================
  function renderTrainerStatus(data) {
    if (!data || !data.success) return;
    const barEl = $('trainerBarFill');
    const textEl = $('trainerGaugeText');
    const runBtn = $('btnRunTrainerNow');
    const stopBtn = $('btnStopTrainerNow');

    const total = Number(data.totalScenarios) || 150;
    const covered = Number(data.coveredCount) || 0;
    const liveCovered = Number(data.liveCoveredCount) || 0;
    const livePct = Number(data.liveCoveragePct) || 0;
    const covPct = Number(data.coveragePct) || 0;
    const passPct = Number(data.passRatePct) || 0;
    const zeroFix = Number(data.consecutiveZeroFixCount) || 0;
    const isRunning = Boolean(data.activeRun && data.activeRun.running);

    if (barEl) {
      barEl.style.width = `${Math.min(100, Math.max(0, covPct))}%`;
      barEl.className = `ctx-bar-fill${data.graduated ? '' : covPct < 50 ? ' warn' : ''}`;
    }
    if (textEl) {
      const stateTag = data.graduated
        ? '🎓 已達標畢業（每日排程自動停機）'
        : isRunning
          ? `⏳ 演練中 (${data.activeRun.processedInRun || 0}/${data.activeRun.totalInRun || 0})`
          : '🏃 排程待命 (00:00~03:00)';
      textEl.textContent = `${covPct}% 規則覆蓋 (${covered}/${total})｜實機 ${liveCovered}/${total} (${livePct}%)｜通過率 ${passPct}%｜連過 ${zeroFix}/50｜${stateTag}`;
    }
    if (runBtn) runBtn.disabled = isRunning;
    if (stopBtn) stopBtn.style.display = isRunning ? 'inline-flex' : 'none';

    const catGrid = $('trainerCategoryGrid');
    if (catGrid && Array.isArray(data.categoryStats)) {
      catGrid.innerHTML = data.categoryStats.map((c) => `
        <div class="trainer-cat-pill">
          <div style="font-weight:700;color:#7dd3fc;">${c.num}. ${escapeHtml(c.label.replace(/`/g, ''))}</div>
          <div style="color:#cbd5e1;">覆蓋 ${c.covered}/${c.targetCount}（實機 ${c.liveCovered}）｜通過率 <strong>${c.passRatePct}%</strong></div>
        </div>
      `).join('');
    }
  }

  async function refreshTrainerStatus() {
    try {
      const resp = await fetch('/api/trainer/status');
      const data = await resp.json();
      if (data.success) renderTrainerStatus(data);
    } catch {
      // ignore
    }
  }

  if ($('btnRunTrainerNow')) {
    $('btnRunTrainerNow').addEventListener('click', async () => {
      const btn = $('btnRunTrainerNow');
      btn.disabled = true;
      btn.textContent = '⚡ Hydrogen 測試演練中...';
      try {
        const resp = await fetch('/api/trainer/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testerModel: 'gemini-4-hydrogen-high',
            batchSize: 30,
            liveSampleSize: 1,
            runLiveLlm: false
          })
        });
        const data = await resp.json();
        if (!data.success) {
          showToast(data.error || '演練失敗', true);
        } else {
          if (data.status) renderTrainerStatus(data.status);
          showToast(`✅ Hydrogen 演練完成：測試 ${data.testedCount} 題、通過 ${data.passedCount} 題、自動修補 ${data.healedCount} 題，已同步 ollama調效.md！`);
        }
      } catch (err) {
        showToast(`演練請求失敗: ${err.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ 立即試跑一輪';
        refreshTrainerStatus();
      }
    });
  }

  if ($('btnStopTrainerNow')) {
    $('btnStopTrainerNow').addEventListener('click', async () => {
      const resp = await fetch('/api/trainer/stop', { method: 'POST' });
      const data = await resp.json();
      showToast(data.message || '已送出暫停指令');
      refreshTrainerStatus();
    });
  }

  if ($('btnViewPlaybook')) {
    $('btnViewPlaybook').addEventListener('click', async () => {
      const modal = $('playbookModal');
      if (modal) modal.style.display = 'flex';
      await refreshTrainerStatus();
      try {
        const resp = await fetch('/api/trainer/playbook');
        const data = await resp.json();
        if (data.success && $('playbookMdPreview')) {
          $('playbookMdPreview').innerHTML = renderSimpleMarkdown(data.content || '');
        }
      } catch (err) {
        if ($('playbookMdPreview')) $('playbookMdPreview').textContent = `載入失敗: ${err.message}`;
      }
    });
  }

  if ($('btnClosePlaybookModal')) {
    $('btnClosePlaybookModal').addEventListener('click', () => {
      if ($('playbookModal')) $('playbookModal').style.display = 'none';
    });
  }
  if ($('playbookModal')) {
    $('playbookModal').addEventListener('click', (e) => {
      if (e.target === $('playbookModal')) $('playbookModal').style.display = 'none';
    });
  }

  // ==================== 初始化 ====================
  refreshStatus();
  loadChatHistory();
  refreshContextStatus();
  refreshTrainerStatus();
  refreshGallery(true);
  loadMemory();
})();
