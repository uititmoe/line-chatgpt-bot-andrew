import { createHmac } from 'node:crypto';
import OpenAI from 'openai';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SYSTEM_MESSAGE } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- 紀錄存在記憶體 (Vercel 無法用 fs) ----
let logs = [];

// 驗證 LINE 簽章
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

// 呼叫 LINE Reply API
async function lineReply(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
  });
  const headers = {
    Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  console.log("[LINE REPLY] Request", body);

  const resp = await fetch(url, { method: "POST", headers, body });
  const respText = await resp.text();
  console.log("[LINE REPLY] Response", { status: resp.status, text: respText });

  return resp.ok;
}

// 判斷訊息類型
function isBacklogMessage(text) {
  return text.startsWith("補記");
}
function isSummaryRequest(text) {
  return text.includes("總結");
}
function isLogCandidate(text) {
  // 問句排除
  if (/[嗎\?？]$/.test(text)) return false;
  if (text.startsWith("補記") || text.includes("總結")) return false;

  // 常見日誌動詞
  const verbs = ["起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;

  // 常見狀態語氣
  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;

  return false;
}

// 簡單時間解析
function parseDateTime(text) {
  const now = new Date();
  const tzOffset = 8 * 60;
  const taiwanNow = new Date(now.getTime() + (tzOffset - now.getTimezoneOffset()) * 60000);
  let target = new Date(taiwanNow);

  if (text.includes("前天")) target.setDate(target.getDate() - 2);
  else if (text.includes("昨天")) target.setDate(target.getDate() - 1);
  else if (text.includes("明天")) target.setDate(target.getDate() + 1);

  const mdMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10);
    const day = parseInt(mdMatch[2], 10);
    target.setMonth(month - 1);
    target.setDate(day);
  }

  const hmMatch = text.match(/(\d{1,2})(?:點|:)(\d{1,2})?/);
  if (hmMatch) {
    const hour = parseInt(hmMatch[1], 10);
    const minute = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
    target.setHours(hour, minute, 0, 0);
  }

  return target.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

// ---- 分類（主模組＋輔助），沒命中 → GPT fallback ----
async function classifyStateLog(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `你是日誌分類助理。
請把輸入訊息分成：
1. 主模組（五選一：A. 藝廊工作, B. Podcast, C. 商業漫畫, D. 同人與委託, E. 生活日常）
2. 輔助分類（可多選：行政／財務／SNS／飲食／健康／社交／休息／其他）

只回 JSON，例如：
{"main":["C. 商業漫畫"], "tags":["📢 宣傳／SNS","🧾 行政"]}`,
        },
        { role: "user", content: text },
      ],
      temperature: 0,
    });

    return JSON.parse(r.choices[0].message.content.trim());
  } catch (e) {
    console.error("[GPT 分類錯誤]", e);
    return { main: ["E. 生活日常"], tags: ["📝 紀錄／其他"] };
  }
}

// ---- 短語生成 ----
async function generateShortPhrase(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_MESSAGE || "你是一個熟悉 Jean 狀態的助理" },
        {
          role: "user",
          content: `請根據「我現在的狀態是：${text}」，產生一句不超過30字的自然短語。語氣自然，像熟人聊天，避免浮誇或網路流行語，要有摘要感，可以輕微幽默或鼓勵。`
        }
      ],
      max_tokens: 50
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[短語生成錯誤]", e);
    return "（狀態已記錄）";
  }
}



// ---- 總結 ----
function handleSummary(text) {
  if (logs.length === 0) return "目前沒有任何紀錄可供總結。";

  const now = new Date();
  let filtered = [];

  if (text.includes("一天")) {
    const today = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
    filtered = logs.filter(l => l.time.startsWith(today));
  } else if (text.includes("這週")) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    filtered = logs.filter(l => new Date(l.time) >= weekStart);
  } else if (text.includes("這個月")) {
    const month = now.getMonth();
    const year = now.getFullYear();
    filtered = logs.filter(l => {
      const d = new Date(l.time);
      return d.getMonth() === month && d.getFullYear() === year;
    });
  } else {
    return "請指定「一天」、「這週」或「這個月」的總結。";
  }

  if (filtered.length === 0) return "這段時間沒有紀錄喔！";

  let result = "📊 總結：\n";
  for (const l of filtered) {
    result += `• ${l.time}｜${l.summary}｜${l.category}\n`;
  }

  return result;
}

// ---- LINE Reply ----
async function lineReply(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: 'text', text }]
  });
  const headers = {
    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  console.log('[LINE REPLY] Request', body);

  const resp = await fetch(url, { method: 'POST', headers, body });
  const respText = await resp.text();
  console.log('[LINE REPLY] Response', { status: resp.status, text: respText });

  return resp.ok;
}

// ---- 主處理 ----
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 收 raw body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers["x-line-signature"];

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[SIGNATURE] 驗證失敗");
      return res.status(403).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));
    console.log("[INCOMING BODY]", JSON.stringify(body));

    for (const event of body.events || []) {
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text.trim();
        let aiText = "我這邊忙線一下，等等再試。";

        // 🕹️ 路由判斷
        if (isBacklogMessage(userText)) {
          const parsedTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
          const category = await classifyStateLog(userText);
          const shortPhrase = await generateShortPhrase(userText);
          aiText = `📝 補記：${parsedTime}\n📌 狀態：${userText}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n✨ 小語：${shortPhrase}`;
        } else if (isSummaryRequest(userText)) {
          aiText = "（總結功能還在開發中，可以先手動整理日誌）";
        } else if (isLogCandidate(userText)) {
          const parsedTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
          const category = await classifyStateLog(userText);
          const shortPhrase = await generateShortPhrase(userText);
          aiText = `🕰️ 已記錄：${parsedTime}\n📌 狀態：${userText}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n✨ 小語：${shortPhrase}`;
        } else {
          try {
            const r = await openai.responses.create({
              model: "gpt-4o-mini",
              instructions: SYSTEM_MESSAGE || "你是一個用繁體中文回覆的貼心助理。",
              input: userText,
            });
            aiText = (r.output_text || "").slice(0, 1900);
          } catch (e) {
            console.error("[OpenAI ERROR]", e);
            aiText = `Echo: ${userText}`;
          }
        }

        await lineReply(event.replyToken, aiText);
      }
    }

    res.status(200).end();
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
    if (!res.headersSent) res.status(500).end();
  }
}

    res.status(200).end();
  } catch (e) {
    console.error('[WEBHOOK ERROR]', e);
    if (!res.headersSent) res.status(500).end();
  }
}
