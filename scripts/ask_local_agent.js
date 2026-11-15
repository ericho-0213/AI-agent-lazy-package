/**
 * Antigravity ⇄ 本機端 Ollama Agent 雙向切換橋接腳本
 * 用法：node scripts/ask_local_agent.js "您的任務描述" [model]
 * 供 Antigravity 在對話中直接把任務委派給本機端 Ollama (D:\OllamaModels) 與 10 大工具箱執行。
 */
require('node:dns').setDefaultResultOrder('ipv4first');
const path = require('node:path');
const dotenv = require('dotenv');

const BASE_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(BASE_DIR, '.env') });

const agentCore = require('../server/agentCore');

async function main() {
  const args = process.argv.slice(2);
  const prompt = (args[0] || '').trim();
  const model = (args[1] || process.env.LOCAL_OLLAMA_MODEL || 'qwen2.5:3b').trim();

  if (!prompt) {
    console.error('請提供任務提示詞，例如：node scripts/ask_local_agent.js "巡檢我本機的專案"');
    process.exit(1);
  }

  const res = await agentCore.runAgentTurn({
    message: prompt,
    history: [],
    provider: 'ollama',
    model,
    enableTools: true
  });

  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
