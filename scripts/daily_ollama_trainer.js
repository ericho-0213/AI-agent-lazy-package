/**
 * 獨立執行 Ollama 自主演練與自癒調校腳本
 * 強制鎖定僅可使用 Gemini 4 Hydrogen (gemini-4-hydrogen-high) 作為測試模型
 * 用法：
 *   node scripts/daily_ollama_trainer.js --batch=150 --live=1
 *   node scripts/daily_ollama_trainer.js --hours=3 --full-live
 */
require('node:dns').setDefaultResultOrder('ipv4first');
const path = require('node:path');
const dotenv = require('dotenv');

const BASE_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(BASE_DIR, '.env') });

const ollamaTrainer = require('../server/ollamaTrainer');

function parseCliArgs(argv) {
  const opts = {
    batch: 150,
    hours: 0,
    liveSampleSize: 1,
    fullLive: false
  };
  for (const arg of argv) {
    if (arg.startsWith('--batch=')) opts.batch = Number(arg.slice(8)) || 150;
    else if (arg.startsWith('--hours=')) opts.hours = Number(arg.slice(8)) || 0;
    else if (arg.startsWith('--live=')) opts.liveSampleSize = Number(arg.slice(7)) || 0;
    else if (arg === '--full-live') opts.fullLive = true;
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const maxDurationMs = opts.hours > 0 ? opts.hours * 3600 * 1000 : 180000;

  console.log(`[OllamaTrainer] 測試模型鎖定：${ollamaTrainer.TESTER_MODEL_DISPLAY} (${ollamaTrainer.TESTER_MODEL})`);
  console.log(`[OllamaTrainer] 開始演練：batch=${opts.batch}, fullLive=${opts.fullLive}, liveSampleSize=${opts.liveSampleSize}`);

  const result = await ollamaTrainer.runTrainingBatch({
    testerModel: ollamaTrainer.TESTER_MODEL,
    maxScenarios: opts.batch,
    maxDurationMs,
    runLiveLlm: opts.fullLive,
    liveSampleSize: opts.liveSampleSize,
    trigger: 'cli_manual'
  });

  if (!result.success) {
    console.error('[OllamaTrainer] 失敗:', result.error);
    process.exit(1);
  }

  const st = result.status;
  console.log(`[OllamaTrainer] 本輪完成：測試 ${result.testedCount} 題｜通過 ${result.passedCount} 題｜自動修補 ${result.healedCount} 題｜耗時 ${result.durationMs}ms`);
  console.log(`[OllamaTrainer] 累積進度：${st.coveredCount}/${st.totalScenarios} (${st.coveragePct}%)｜通過率 ${st.passRatePct}%｜連續零修補 ${st.consecutiveZeroFixCount}/50｜畢業=${st.graduated}`);
  console.log(`[OllamaTrainer] 已同步更新手冊：${ollamaTrainer.PLAYBOOK_PATH}`);
}

main().catch((err) => {
  console.error('[OllamaTrainer] 發生錯誤:', err.message);
  process.exit(1);
});
