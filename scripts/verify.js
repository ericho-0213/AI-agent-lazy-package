/**
 * Mini-Antigravity 系統核心與 10 大工具自動驗證腳本
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const BASE_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8790;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function runTests() {
  const results = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail });
      console.log(`[PASS] ${name} (${Date.now() - t0}ms): ${detail}`);
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
      console.error(`[FAIL] ${name}: ${err.message}`);
    }
  };

  await check('GET /api/status', async () => {
    const r = await fetch(`${BASE_URL}/api/status`);
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.ok(d.toolsCount >= 10);
    return `tools=${d.toolsCount}, ollamaOnline=${d.ollama.online}, models=${d.ollama.models.map((m) => m.name).join(',') || 'none'}`;
  });

  const projectsRoot = path.resolve(BASE_DIR, '..');
  const hasIpqc = fs.existsSync(path.join(projectsRoot, 'IPQC檢驗系統', 'data'));
  const hasAoi = fs.existsSync(path.join(projectsRoot, 'AOI覆判系統', 'data', 'cases.json'));

  await check('GET /api/tools/projects (本機全專案巡檢)', async () => {
    const r = await fetch(`${BASE_URL}/api/tools/projects`);
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.ok(d.totalCount >= 1);
    return `偵測 ${d.totalCount} 個專案 (AGENTS=${d.withAgentsCount}, VBS=${d.withVbsCount}, Git=${d.withGitCount})`;
  });

  await check('GET /api/tools/mes-spc (5LA261106-A10)', async () => {
    const r = await fetch(`${BASE_URL}/api/tools/mes-spc?lotNo=5LA261106-A10`);
    const d = await r.json();
    if (!hasIpqc) {
      assert.strictEqual(d.success, false);
      assert.ok(d.error);
      return `新機尚無鄰近 IPQC 專案，API 正常回傳降級提示: ${d.error}`;
    }
    assert.strictEqual(d.success, true);
    assert.strictEqual(d.info.lotNo, '5LA261106-A10');
    assert.ok(d.analyzedItems.length >= 2);
    const first = d.analyzedItems[0];
    return `${first.itemName}: mean=${first.spc.mean}, Cpk=${first.spc.cpk}`;
  });

  await check('GET /api/tools/aoi (AOI 案件與 KLA)', async () => {
    const r = await fetch(`${BASE_URL}/api/tools/aoi`);
    const d = await r.json();
    if (!hasAoi) {
      assert.strictEqual(d.success, false);
      assert.ok(d.error);
      return `新機尚無鄰近 AOI 專案，API 正常回傳降級提示: ${d.error}`;
    }
    assert.strictEqual(d.success, true);
    assert.ok(d.totalCases > 0);
    return `total=${d.totalCases}, pending=${d.pendingCount}, closed=${d.closedCount}`;
  });

  await check('POST /api/tools/excel-parse (Zero-OOM 解析現場 Excel)', async () => {
    const listR = await fetch(`${BASE_URL}/api/tools/excel-list`);
    const listD = await listR.json();
    assert.strictEqual(listD.success, true);
    assert.ok(Array.isArray(listD.files));
    if (listD.files.length === 0) {
      const missingR = await fetch(`${BASE_URL}/api/tools/excel-parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: path.join(BASE_DIR, '__nonexistent__.xlsx'), maxRows: 5 })
      });
      const missingD = await missingR.json();
      assert.strictEqual(missingD.success, false);
      return '新機尚無現成 .xlsx 檔案，Excel 清單與錯誤防護 API 回應正常';
    }
    const sample = listD.files.find((f) => f.name.includes('AOI')) || listD.files[0];

    const r = await fetch(`${BASE_URL}/api/tools/excel-parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: sample.path, maxRows: 10 })
    });
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.strictEqual(d.headerHex, '504B0304');
    return `${sample.name}: header=${d.headerHex}, elapsed=${d.elapsedMs}ms, sheets=${d.allSheetNames.join(',')}`;
  });

  await check('GET /api/tools/secondbrain (Obsidian 連結)', async () => {
    const r = await fetch(`${BASE_URL}/api/tools/secondbrain?action=list_hubs`);
    const d = await r.json();
    if (!d.success && typeof d.error === 'string' && d.error.includes('Secondbrain')) {
      return `新機尚未建立 Obsidian Secondbrain 目錄，API 正常降級回傳: ${d.error}`;
    }
    assert.strictEqual(d.success, true);
    assert.ok(d.count >= 5);
    return `HUB 筆記數=${d.count}`;
  });

  await check('POST /api/image/generate (離線 SVG 工程向量圖)', async () => {
    const r = await fetch(`${BASE_URL}/api/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '半導體晶圓光學檢測微米缺陷示意圖',
        engine: 'local-svg',
        width: 1024,
        height: 1024
      })
    });
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.ok(fs.existsSync(d.filePath));
    return `saved=${d.filename}`;
  });

  await check('POST /api/image/generate (AI 雲端自由生圖 Flux)', async () => {
    const r = await fetch(`${BASE_URL}/api/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'futuristic semiconductor cleanroom wafer inspection robot arm, neon blue lighting',
        engine: 'flux',
        style: 'cyberpunk',
        width: 512,
        height: 512
      })
    });
    const d = await r.json();
    assert.strictEqual(d.success, true);
    assert.ok(fs.existsSync(d.filePath));
    return `engine=${d.engine}, fallback=${Boolean(d.fallbackUsed)}, file=${d.filename}`;
  });

  await check('MEMORY 🔴 鐵律保護驗證', async () => {
    const r = await fetch(`${BASE_URL}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'MEMORY', content: '# wiped' })
    });
    assert.strictEqual(r.status, 400);
    const d = await r.json();
    assert.strictEqual(d.success, false);
    return `成功攔截刪除鐵律: ${d.error.slice(0, 40)}`;
  });

  await check('純 DIB ICO 格式檔頭驗證 (16/32/48/64)', async () => {
    const icoPath = path.join(BASE_DIR, 'runtime', 'ai_agent.ico');
    assert.ok(fs.existsSync(icoPath), '找不到 runtime/ai_agent.ico');
    const buf = fs.readFileSync(icoPath);
    assert.strictEqual(buf.readUInt16LE(0), 0);
    assert.strictEqual(buf.readUInt16LE(2), 1);
    const count = buf.readUInt16LE(4);
    assert.strictEqual(count, 4);
    // 驗證每個圖層為 BITMAPINFOHEADER (biSize = 40) 而非 PNG (0x89504E47)
    for (let i = 0; i < count; i++) {
      const imgOffset = buf.readUInt32LE(6 + i * 16 + 12);
      const biSize = buf.readUInt32LE(imgOffset);
      assert.strictEqual(biSize, 40, `圖層 ${i} 非純 DIB 格式`);
    }
    return `ICO bytes=${buf.length}, DIB 圖層數=${count}`;
  });

  await check('成長治理：記憶學習 Diff 提案 → 核准寫入 → 原子回退驗證', async () => {
    const govRes = await (await fetch(`${BASE_URL}/api/memory/governance`)).json();
    const origPolicy = govRes.policy || 'review';
    const testRule = '__VERIFY_DIFF_GOV_RULE__ 回報前優先附上量測單位';

    try {
      await fetch(`${BASE_URL}/api/memory/governance/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: 'review' })
      });

      // 1. 建立待核准提案 (不直接寫入 MEMORY.md)
      const propR = await fetch(`${BASE_URL}/api/memory/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'MEMORY', ruleText: testRule, sourceMessage: 'verify test' })
      });
      const propD = await propR.json();
      assert.strictEqual(propD.success, true);
      assert.strictEqual(propD.pending, true);
      assert.ok(propD.proposal && propD.proposal.id);
      assert.ok(propD.diffPreview && propD.diffPreview.includes('+ - ['));

      const memBefore = await (await fetch(`${BASE_URL}/api/memory`)).json();
      assert.ok(!memBefore.files.MEMORY.includes(testRule), '審核模式下提案不應提前寫入 MEMORY.md');

      // 2. 核准提案並確認寫入 MEMORY.md
      const appR = await fetch(`${BASE_URL}/api/memory/proposals/${encodeURIComponent(propD.proposal.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const appD = await appR.json();
      assert.strictEqual(appD.success, true);
      assert.ok(appD.applied && appD.applied.id);
      assert.ok(appD.files.MEMORY.includes(testRule), '核准後應寫入 MEMORY.md');

      // 3. 原子回退並確認精準移除、紅線鐵律完好
      const rbR = await fetch(`${BASE_URL}/api/memory/applied/${encodeURIComponent(appD.applied.id)}/rollback`, {
        method: 'POST'
      });
      const rbD = await rbR.json();
      assert.strictEqual(rbD.success, true);
      assert.strictEqual(rbD.removedFromFile, true);
      assert.ok(!rbD.files.MEMORY.includes(testRule), '回退後應精準從 MEMORY.md 撤銷該條規則');
      assert.ok(rbD.governance.redRuleCount >= 5, '🔴 核心鐵律不可受回退影響');

      return `proposalId=${propD.proposal.id}, appliedId=${appD.applied.id}, rollbackOk=true`;
    } finally {
      await fetch(`${BASE_URL}/api/memory/governance/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: origPolicy })
      });
    }
  });

  await check('長對話上下文 Token 水位計 & 摘要壓縮驗證', async () => {
    const ctxPath = path.join(BASE_DIR, 'memory', 'context_summary.json');
    const hadFile = fs.existsSync(ctxPath);
    const backup = hadFile ? fs.readFileSync(ctxPath, 'utf8') : null;

    try {
      const stR = await fetch(`${BASE_URL}/api/chat/context-status`);
      const stD = await stR.json();
      assert.strictEqual(stD.success, true);
      assert.ok(stD.budgetTokens >= 2048);

      const syntheticHistory = [
        { role: 'user', content: '請問批號 5LA261106-A10 的黏度 SPC 數據如何？' },
        { role: 'assistant', content: '批號 5LA261106-A10 黏度平均值 52.55，Cpk 43.114，全數合格。' },
        { role: 'user', content: '那 AOI 目前有幾件待覆判案件？請順便摘要重點。' },
        { role: 'assistant', content: '目前共有多筆覆判案件，並已完成 KLA 座標與面積統計。' },
        { role: 'user', content: '請幫我生一張晶圓光學檢測的寫實高解析圖，並且標註微米尺寸。' },
        { role: 'assistant', content: '已完成本機 DreamShaper-7 寫實圖生成，可帶入 Sobel 量測畫布量測。' }
      ];

      const cmpR = await fetch(`${BASE_URL}/api/chat/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: syntheticHistory,
          keepRecentMessages: 2,
          force: true,
          persist: false
        })
      });
      const cmpD = await cmpR.json();
      assert.strictEqual(cmpD.success, true);
      assert.strictEqual(cmpD.compacted, true);
      assert.strictEqual(cmpD.compactedMessagesCount, 4);
      assert.strictEqual(cmpD.keptMessagesCount, 2);
      assert.ok(cmpD.rollingSummary && cmpD.rollingSummary.length >= 10);
      assert.ok(cmpD.contextStatus && typeof cmpD.contextStatus.usagePct === 'number');

      return `baseTokens=${stD.totalTokens}/${stD.budgetTokens}, compacted=${cmpD.compactedMessagesCount}->kept=${cmpD.keptMessagesCount}, savedTokens=${cmpD.savedTokensDelta}`;
    } finally {
      if (hadFile) {
        fs.writeFileSync(ctxPath, backup, 'utf8');
      } else if (fs.existsSync(ctxPath)) {
        fs.unlinkSync(ctxPath);
      }
    }
  });

  await check('圖片工坊：清除歷史對話與隱私無痕模式驗證 (DELETE /api/image/history)', async () => {
    const tastePath = path.join(BASE_DIR, 'memory', 'image_taste.json');
    const galleryPath = path.join(BASE_DIR, 'memory', 'image_gallery.json');
    const govPath = path.join(BASE_DIR, 'memory', 'learning_governance.json');
    const chatPath = path.join(BASE_DIR, 'memory', 'chat_history.json');

    const snapshot = [tastePath, galleryPath, govPath, chatPath].map((p) => ({
      path: p,
      existed: fs.existsSync(p),
      content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    }));
    const createdFiles = [];

    try {
      const tasteBefore = fs.existsSync(tastePath) ? fs.readFileSync(tastePath, 'utf8') : '';

      // 1. 測試「隱私無痕模式」：生圖不應寫入 image_taste.json 或保留真實 prompt
      const privR = await fetch(`${BASE_URL}/api/image/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '__PRIVATE_STUDIO_PROMPT__ 柔焦散景測試',
          engine: 'local-svg',
          width: 512,
          height: 512,
          privateMode: true
        })
      });
      const privD = await privR.json();
      assert.strictEqual(privD.success, true);
      if (privD.filePath) createdFiles.push(privD.filePath);

      const galAfterPriv = await (await fetch(`${BASE_URL}/api/image/gallery`)).json();
      const privEntry = (galAfterPriv.items || []).find((x) => x.filename === privD.filename);
      assert.ok(privEntry, '圖庫應包含無痕建立之圖片項目');
      assert.strictEqual(privEntry.prompt, '[隱私無痕創作]');
      assert.strictEqual(privEntry.translatedPrompt, '');

      const tasteAfterPriv = fs.existsSync(tastePath) ? fs.readFileSync(tastePath, 'utf8') : '';
      assert.strictEqual(tasteAfterPriv, tasteBefore, '隱私無痕模式不可改動 image_taste.json');

      // 2. 建立一般生圖與偏好紀錄，再測試 DELETE /api/image/history 徹底抹除
      const normR = await fetch(`${BASE_URL}/api/image/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '__SCRUB_TARGET_PROMPT__ 微距高對比測試',
          engine: 'local-svg',
          width: 512,
          height: 512,
          privateMode: false
        })
      });
      const normD = await normR.json();
      assert.strictEqual(normD.success, true);
      if (normD.filePath) createdFiles.push(normD.filePath);

      const delR = await fetch(`${BASE_URL}/api/image/history`, { method: 'DELETE' });
      const delD = await delR.json();
      assert.strictEqual(delD.success, true);
      assert.strictEqual(delD.clearedTaste, true);

      const tasteCleaned = JSON.parse(fs.readFileSync(tastePath, 'utf8'));
      assert.deepStrictEqual(tasteCleaned.recentInstructions, []);
      assert.deepStrictEqual(tasteCleaned.tasteTags, {});
      assert.strictEqual(tasteCleaned.totalInteractions, 0);

      const galleryCleaned = JSON.parse(fs.readFileSync(galleryPath, 'utf8'));
      for (const item of galleryCleaned) {
        assert.strictEqual(item.prompt, '[已清除隱私對話紀錄]');
        assert.strictEqual(item.translatedPrompt, '');
        assert.deepStrictEqual(item.agentFeedback, []);
      }

      return `privateMode=ok, scrubbedGallery=${delD.scrubbedGalleryItems}, tasteReset=ok`;
    } finally {
      for (const fp of createdFiles) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      }
      for (const item of snapshot) {
        if (item.existed) {
          fs.writeFileSync(item.path, item.content, 'utf8');
        } else if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
        }
      }
    }
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\n總結: ${results.length - failed.length}/${results.length} 通過`);
  if (failed.length > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
