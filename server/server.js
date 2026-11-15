/**
 * Mini-Antigravity 本機自主 AI Agent 中樞 — 主伺服器 (Port 8790)
 */
require('node:dns').setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

const BASE_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(BASE_DIR, '.env') });

const agentCore = require('./agentCore');
const projectTools = require('./projectTools');
const imageEngine = require('./imageEngine');

const PORT = Number(process.env.PORT) || 8790;
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));
app.use('/outputs', express.static(path.join(BASE_DIR, 'outputs')));

const CHAT_LOG_PATH = path.join(BASE_DIR, 'memory', 'chat_history.json');

function loadChatHistory() {
  if (!fs.existsSync(CHAT_LOG_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_LOG_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveChatHistory(items) {
  fs.mkdirSync(path.dirname(CHAT_LOG_PATH), { recursive: true });
  fs.writeFileSync(CHAT_LOG_PATH, JSON.stringify(items.slice(-60), null, 2), 'utf8');
}

async function fetchOllamaTags() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${agentCore.OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return { online: false, models: [] };
    const data = await resp.json();
    return { online: true, models: Array.isArray(data.models) ? data.models : [] };
  } catch {
    return { online: false, models: [] };
  }
}

/**
 * 系統狀態與雙腦偵測
 */
app.get('/api/status', async (req, res) => {
  const ollama = await fetchOllamaTags();
  const hasGeminiKey = Boolean(agentCore.resolveGeminiApiKey());
  const ollamaModelsDir = process.env.OLLAMA_MODELS || path.join(path.parse(BASE_DIR).root, 'OllamaModels');
  res.json({
    success: true,
    port: PORT,
    baseDir: BASE_DIR,
    ollamaModelsDir,
    hardware: {
      cpu: os.cpus()[0] ? os.cpus()[0].model : 'Unknown CPU',
      cores: os.cpus().length,
      totalRamGB: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
      freeRamGB: Math.round((os.freemem() / (1024 ** 3)) * 10) / 10
    },
    ollama,
    localSd: imageEngine.getLocalSdStatus(),
    geminiAvailable: hasGeminiKey,
    toolsCount: agentCore.TOOL_DEFINITIONS.length,
    tools: agentCore.TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description }))
  });
});

/**
 * Agent 對話端點 (ReAct Loop + 自動檢查點壓縮)
 */
app.get('/api/chat/history', (req, res) => {
  const history = loadChatHistory();
  res.json({
    success: true,
    history,
    contextStatus: agentCore.computeContextStatus({ history })
  });
});

app.delete('/api/chat/history', (req, res) => {
  saveChatHistory([]);
  projectTools.saveContextState({
    rollingSummary: '',
    compactedCount: 0,
    savedTokens: 0,
    lastCompactedAt: null
  });

  // 一併清除交接橋接殘留，避免舊對話透過 handoff 區塊佔用上下文基底
  const handoffPath = path.join(BASE_DIR, 'handoff.md');
  if (fs.existsSync(handoffPath)) {
    const cur = fs.readFileSync(handoffPath, 'utf8');
    const cleaned = cur
      .replace(/\s*<!-- BRIDGE_SYNC_START -->[\s\S]*?<!-- BRIDGE_SYNC_END -->\s*/g, '\n')
      .trimEnd() + '\n';
    if (cleaned !== cur) {
      fs.writeFileSync(handoffPath, cleaned, 'utf8');
    }
  }
  const bridgePath = path.join(projectTools.MEMORY_DIR, 'antigravity_bridge.md');
  if (fs.existsSync(bridgePath)) {
    fs.writeFileSync(bridgePath, '', 'utf8');
  }

  res.json({
    success: true,
    contextStatus: agentCore.computeContextStatus({ history: [] })
  });
});

app.get('/api/chat/context-status', (req, res) => {
  const history = loadChatHistory();
  const provider = req.query.provider || 'ollama';
  res.json({
    success: true,
    ...agentCore.computeContextStatus({ history, provider })
  });
});

app.post('/api/chat/context-config', (req, res) => {
  const { budgetTokens, thresholdPct } = req.body || {};
  const patch = {};
  if (budgetTokens !== undefined) patch.budgetTokens = Number(budgetTokens);
  if (thresholdPct !== undefined) patch.thresholdPct = Number(thresholdPct);
  projectTools.saveContextState(patch);
  const history = loadChatHistory();
  res.json({
    success: true,
    ...agentCore.computeContextStatus({ history })
  });
});

app.post('/api/chat/compact', async (req, res) => {
  try {
    const {
      provider = 'ollama',
      model = 'qwen2.5:3b',
      keepRecentMessages = 4,
      force = true,
      history: customHistory,
      persist
    } = req.body || {};

    const useDiskHistory = !Array.isArray(customHistory);
    const targetHistory = useDiskHistory ? loadChatHistory() : customHistory;
    const result = await agentCore.compactChatHistory({
      history: targetHistory,
      provider,
      model,
      keepRecentMessages: Number(keepRecentMessages) || 4,
      force: Boolean(force)
    });

    if (result.compacted && (useDiskHistory || persist === true)) {
      saveChatHistory(result.remainingHistory);
    }

    res.json({
      ...result,
      history: result.remainingHistory
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history,
      provider = 'ollama',
      model = 'qwen2.5:3b',
      enableTools = true
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: '訊息不可為空' });
    }

    const storedHistory = Array.isArray(history) ? history : loadChatHistory();
    const result = await agentCore.runAgentTurn({
      message: String(message),
      history: storedHistory,
      provider,
      model,
      enableTools: Boolean(enableTools)
    });

    const baseHistory = Array.isArray(result.compactedHistory) ? result.compactedHistory : storedHistory;
    const nextHistory = [
      ...baseHistory,
      { role: 'user', content: String(message), timestamp: new Date().toISOString() },
      {
        role: 'assistant',
        content: result.reply,
        trace: result.trace,
        generatedImages: result.generatedImages,
        learned: result.learned,
        model: result.model,
        provider: result.provider,
        elapsedMs: result.elapsedMs,
        timestamp: new Date().toISOString()
      }
    ];
    saveChatHistory(nextHistory);

    res.json({
      ...result,
      history: nextHistory
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 從戰情室一鍵拉取 Ollama 模型至 D:\OllamaModels
 */
const pullJobs = new Map();

app.post('/api/ollama/pull', async (req, res) => {
  const modelName = String((req.body && req.body.model) || '').trim();
  if (!modelName || !/^[a-zA-Z0-9._:-]+$/.test(modelName)) {
    return res.status(400).json({ success: false, error: '無效的模型名稱' });
  }

  const jobId = `pull_${Date.now()}`;
  pullJobs.set(jobId, { model: modelName, status: 'starting', detail: '正在連線 Ollama 拉取模型...', done: false });

  (async () => {
    try {
      const resp = await fetch(`${agentCore.OLLAMA_BASE}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true })
      });
      if (!resp.ok) {
        pullJobs.set(jobId, { model: modelName, status: 'error', detail: `HTTP ${resp.status}`, done: true });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            const pct = evt.total ? Math.round((evt.completed / evt.total) * 100) : null;
            pullJobs.set(jobId, {
              model: modelName,
              status: evt.status || 'downloading',
              percent: pct,
              detail: pct !== null ? `${evt.status} (${pct}%)` : (evt.status || '處理中'),
              done: evt.status === 'success'
            });
          } catch {
            // ignore chunk parse
          }
        }
      }
      const cur = pullJobs.get(jobId);
      if (cur && !cur.done) {
        pullJobs.set(jobId, { ...cur, status: 'success', detail: '模型下載完成', done: true });
      }
    } catch (err) {
      pullJobs.set(jobId, { model: modelName, status: 'error', detail: err.message, done: true });
    }
  })();

  res.json({ success: true, jobId, model: modelName });
});

app.get('/api/ollama/pull/:jobId', (req, res) => {
  const job = pullJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: '找不到下載任務' });
  res.json({ success: true, ...job });
});

/**
 * 圖片自由創建與圖庫 API
 */
app.get('/api/image/gallery', (req, res) => {
  res.json({ success: true, items: imageEngine.listGallery() });
});

app.post('/api/image/generate', async (req, res) => {
  try {
    const {
      prompt,
      engine = 'local-sd',
      style = 'photorealistic',
      width = 512,
      height = 512,
      seed,
      provider = 'ollama',
      llmModel = 'qwen2.5:3b',
      privateMode = false
    } = req.body || {};

    const isPrivate = Boolean(privateMode);
    const translatePromptFn = agentCore.createPromptTranslator(provider, llmModel);
    const result = await imageEngine.generateAiImage({
      prompt,
      engine,
      style,
      width,
      height,
      seed: seed ? Number(seed) : Math.floor(Math.random() * 999999),
      translatePromptFn,
      privateMode: isPrivate
    });
    if (result && result.success && !isPrivate) {
      const taste = projectTools.recordImageTaste({ prompt, style, engine });
      result.learnedTaste = taste.summaryText;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/image/assist', async (req, res) => {
  try {
    const {
      prompt = '',
      instruction = '',
      style = 'photorealistic',
      engine = 'local-sd',
      provider = 'ollama',
      llmModel = 'qwen2.5:3b',
      privateMode = false
    } = req.body || {};

    const result = await agentCore.assistImagePrompt({
      prompt,
      instruction,
      style,
      engine,
      provider,
      model: llmModel,
      privateMode: Boolean(privateMode)
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/image/history', (req, res) => {
  try {
    const tasteRes = projectTools.clearImageTasteHistory();
    const galleryRes = imageEngine.scrubGalleryPrompts();
    const history = loadChatHistory();
    let scrubbedChatCount = 0;
    const nextHistory = history.map((msg) => {
      if (Array.isArray(msg.generatedImages) && msg.generatedImages.length > 0) {
        scrubbedChatCount++;
        return {
          ...msg,
          generatedImages: msg.generatedImages.map((img) => ({
            ...img,
            prompt: '[已清除隱私對話紀錄]'
          }))
        };
      }
      return msg;
    });
    if (scrubbedChatCount > 0) {
      saveChatHistory(nextHistory);
    }
    res.json({
      success: true,
      clearedTaste: true,
      scrubbedGalleryItems: galleryRes.scrubbedCount,
      scrubbedChatCount,
      removedPendingProposalsCount: tasteRes.removedPendingProposalsCount,
      governance: projectTools.getLearningStatus()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/image/strip-watermarks', async (req, res) => {
  try {
    res.json(await imageEngine.stripExistingWatermarksInGallery());
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/image/gallery/:filename', (req, res) => {
  res.json(imageEngine.deleteGalleryImage(req.params.filename));
});

/**
 * 本機專案特定功能中控台 API
 */
app.get('/api/tools/projects', async (req, res) => {
  try {
    res.json(await projectTools.scanLocalProjects());
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools/mes-spc', (req, res) => {
  try {
    res.json(projectTools.queryMesAndSpc({ lotNo: req.query.lotNo || '' }));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools/aoi', (req, res) => {
  try {
    res.json(projectTools.inspectAoiSystem({ limit: req.query.limit || 15 }));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools/excel-list', (req, res) => {
  try {
    res.json({ success: true, files: projectTools.listLocalExcelFiles() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tools/excel-parse', async (req, res) => {
  try {
    const { filePath, sheetName = '', maxRows = 35 } = req.body || {};
    res.json(await projectTools.parseExcelSafe({ filePath, sheetName, maxRows }));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools/outlook', async (req, res) => {
  try {
    res.json(await projectTools.queryOutlookSafe({
      mode: req.query.mode || 'calendar',
      keyword: req.query.keyword || '',
      days: req.query.days || 14
    }));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools/secondbrain', (req, res) => {
  try {
    res.json(projectTools.secondbrainTool({
      action: req.query.action || 'list_hubs',
      query: req.query.query || '',
      notePath: req.query.notePath || ''
    }));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tools/secondbrain', (req, res) => {
  try {
    res.json(projectTools.secondbrainTool(req.body || {}));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Hermes 靈魂與長期記憶 API
 */
app.get('/api/memory', (req, res) => {
  res.json({ success: true, files: projectTools.readMemoryFiles() });
});

app.post('/api/memory', (req, res) => {
  const { file, content } = req.body || {};
  const result = projectTools.saveMemoryFile(file, content);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/memory/learning-status', (req, res) => {
  res.json(projectTools.getLearningStatus());
});

app.get('/api/memory/governance', (req, res) => {
  res.json(projectTools.getLearningStatus());
});

app.post('/api/memory/governance/policy', (req, res) => {
  const { policy } = req.body || {};
  res.json(projectTools.setLearningPolicy(policy));
});

app.post('/api/memory/proposals', (req, res) => {
  const { target = 'MEMORY', ruleText = '', tag = '自主學習', sourceMessage = '', forceAuto = false } = req.body || {};
  const result = projectTools.proposeOrApplyLearnedRule({
    target,
    ruleText,
    tag,
    sourceMessage,
    forceAuto: Boolean(forceAuto)
  });
  res.status(result.success ? 200 : 400).json({
    ...result,
    governance: projectTools.getLearningStatus()
  });
});

app.post('/api/memory/proposals/approve-all', (req, res) => {
  const result = projectTools.approveAllLearningProposals();
  res.json(result);
});

app.post('/api/memory/proposals/:id/approve', (req, res) => {
  const { customRuleText, customTarget } = req.body || {};
  const result = projectTools.approveLearningProposal(req.params.id, { customRuleText, customTarget });
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/memory/proposals/:id/reject', (req, res) => {
  const result = projectTools.rejectLearningProposal(req.params.id);
  res.status(result.success ? 200 : 404).json(result);
});

app.post('/api/memory/applied/:id/rollback', (req, res) => {
  const result = projectTools.rollbackAppliedRule(req.params.id);
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/memory/auto-learn', async (req, res) => {
  try {
    const { provider = 'ollama', model = 'qwen2.5:3b' } = req.body || {};
    const history = loadChatHistory();
    const result = await agentCore.summarizeRecentChatsAndLearn({
      history,
      provider,
      model
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Antigravity ⇄ 本機 Ollama 雙向交接橋接 API
 */
app.get('/api/bridge', (req, res) => {
  const bridgePath = path.join(projectTools.MEMORY_DIR, 'antigravity_bridge.md');
  const content = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf8') : '';
  res.json({ success: true, path: bridgePath, content });
});

app.post('/api/bridge/sync', (req, res) => {
  const bridgePath = path.join(projectTools.MEMORY_DIR, 'antigravity_bridge.md');
  const handoffPath = path.join(BASE_DIR, 'handoff.md');
  if (!fs.existsSync(bridgePath)) {
    return res.json({ success: true, synced: false, message: '尚無交接快照' });
  }
  const bridgeText = fs.readFileSync(bridgePath, 'utf8').slice(0, 1800);
  const currentHandoff = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
  const marker = '<!-- BRIDGE_SYNC_START -->';
  const markerEnd = '<!-- BRIDGE_SYNC_END -->';
  const block = `${marker}\n### 🔄 本機 Ollama 最新對話交接摘要\n${bridgeText}\n${markerEnd}`;
  const updated = currentHandoff.includes(marker)
    ? currentHandoff.replace(new RegExp(`${marker}[\\s\\S]*?${markerEnd}`), block)
    : `${currentHandoff.trim()}\n\n${block}\n`;
  fs.writeFileSync(handoffPath, updated, 'utf8');
  res.json({ success: true, synced: true, handoffPath });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Mini-Antigravity] Web 戰情室已啟動於 http://localhost:${PORT}`);
});
