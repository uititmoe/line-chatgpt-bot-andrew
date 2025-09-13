import { createHmac } from 'node:crypto';
import OpenAI from 'openai';
import fs from 'fs';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SYSTEM_MESSAGE } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 驗證 LINE 簽章
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

// --- 輔助判斷 ---
function isBacklogMessage(text) {
  return text.startsWith("補記");
}

function isLogMessage(text) {
  if (
    text.endsWith("嗎？") || text.endsWith("嗎?") || text.endsWith("?") ||
    text.startsWith("幫我")
  ) {
    return false;
  }
  return true;
}

function isSummaryRequest(text) {
  return text.includes("總結");
}

// --- 時間解析 ---
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

// --- 儲存 / 讀取紀錄 ---
function saveLog(entry) {
  let logs = [];
  if (fs.existsSync("logs.json")) {
    logs = JSON.parse(fs.readFileSync("logs.json", "utf8"));
  }
  logs.push(entry);
  fs.writeFileSync("logs.json", JSON.stringify(logs, null, 2));
}

function loadLogs() {
  if (fs.existsSync("logs.json")) {
    return JSON.parse(fs.readFileSync("logs.json", "utf8"));
  }
  return [];
}

// --- 分類器（主模組 + 輔助分類 + GPT fallback）---
async function classifyStateLog(text) {
  const gallery_keywords = ["藝廊","畫廊","展覽","佈展","撤展","展場","策展","展覽籌備","展覽安排","現場值班","顧展","顧店",
    "收店","整理展場","整理藝廊","展品","寄賣","報表","帳務","合約","合作","藝術家","對帳","查帳","結帳","會議","開會","陸角銀"];
  const podcast_keywords = ["Podcast","錄音","音檔","剪輯","混音","直播","預告","EP","音訊處理"];
  const manga_keywords = ["商業漫畫","分鏡","長篇","劇本","稿子","漫畫","原稿","連載"];
  const doujin_keywords = ["同人","委託","簽名板","彩圖","彩稿","出本","網點","加印","通販","出貨","寄件","本子","同人誌"];
  const space_keywords = ["打掃","清掃","整理辦公室","值班","清空","回收","洗衣店","收拾","環境"];

  const admin_keywords = ["回信","收信","處理雜務","訊息","SNS","申請","資料","通知","聯絡","整理","包裝","寄件","收件","郵寄","宅配"];
  const finance_keywords = ["記帳","帳務","收據","報帳","對帳","分潤","會計","發票","報表","財務"];
  const sns_keywords = ["SNS","社群","宣傳","發文","寫文案","翻譯","推廣"];
  const food_keywords = ["早餐","午餐","晚餐","吃飯","點心","吃東西","咖啡","喝了","聚餐","買飯","買飲料"];
  const shopping_keywords = ["去超市","買東西","買菜","買文具","補貨","採購","補充","逛"];
  const rest_keywords = ["休息","滑手機","看影片","放空","睡","午休","躺著","洗澡","洗頭","煮飯","便當","備餐","洗碗","洗衣服","美甲","指甲"];
  const social_keywords = ["朋友","家人","聊天","見面","聚會","合照","應對客人","會面"];
  const planning_keywords = ["構思","發想","規劃","靈感","腳本","故事","思考","分鏡","改腳本","看素材","研究"];
  const hobby_keywords = ["跳舞","探戈","健身","運動","瑜珈","跑步","拳擊","看劇","追劇","電影","動畫","舞台劇","歌劇","看書","閱讀","小說","漫畫"];

  const mainModules = [];
  const tags = [];

  if (gallery_keywords.some(kw => text.includes(kw))) mainModules.push("A. 藝廊工作");
  if (podcast_keywords.some(kw => text.includes(kw))) mainModules.push("B. Podcast");
  if (manga_keywords.some(kw => text.includes(kw))) mainModules.push("C. 商業漫畫");
  if (doujin_keywords.some(kw => text.includes(kw))) mainModules.push("D. 同人＆委託");
  if (space_keywords.some(kw => text.includes(kw))) mainModules.push("E. 空間管理");

  if (admin_keywords.some(kw => text.includes(kw))) tags.push("📑 行政雜務");
  if (finance_keywords.some(kw => text.includes(kw))) tags.push("💰 財務／記帳");
  if (sns_keywords.some(kw => text.includes(kw))) tags.push("📢 宣傳／SNS");
  if (food_keywords.some(kw => text.includes(kw))) tags.push("🍽️ 飲食");
  if (shopping_keywords.some(kw => text.includes(kw))) tags.push("🛒 生活採購");
  if (rest_keywords.some(kw => text.includes(kw))) tags.push("🧘 休息／日常");
  if (social_keywords.some(kw => text.includes(kw))) tags.push("💼 社交活動");
  if (planning_keywords.some(kw => text.includes(kw))) tags.push("💡 構思／規劃");
  if (hobby_keywords.some(kw => text.includes(kw))) tags.push("🎯 興趣／休閒活動");

  if (mainModules.length > 0 || tags.length > 0) {
    return { main: mainModules, tags: tags };
  }

  // GPT fallback
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "請將輸入的內容分類到以下其中一個最合適的分類，不要加解釋，只回分類標籤。\n" +
            "主模組：A. 藝廊工作, B. Podcast, C. 商業漫畫, D. 同人＆委託, E. 空間管理\n" +
            "輔助分類：📑 行政雜務, 💰 財務／記帳, 📢 宣傳／SNS, 🍽️ 飲食, 🛒 生活採購, 🧘 休息／日常, 💼 社交活動, 💡 構思／規劃, 🎯 興趣／休閒活動, 📝 紀錄／其他"
        },
        { role: "user", content: text }
      ],
      max_tokens: 30
    });
    return { main: [], tags: [r.choices[0].message.content.trim()] };
  } catch (e) {
    console.error("[GPT 分類錯誤]", e);
    return { main: [], tags: ["📝 紀錄／其他"] };
  }
}

// --- 短語生成 ---
async function generateShortPhrase(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_MESSAGE || "你是一個熟悉 Jean 狀態的助理" },
        {
          role: "user",
          content: `請根據「我現在的狀態是：${text}」，產生一句不超過30字的自然短語。語氣自然，像熟人聊天，避免浮誇或網路流行語，要有摘要感。`
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

// --- 總結 ---
function handleSummary(text) {
  const logs = loadLogs();
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
    result += `• ${l.time}｜${l.summary}｜${[...(l.category.main||[]), ...(l.category.tags||[])].join(" + ")}\n`;
  }

  return result;
}

// --- LINE Reply ---
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

// --- 主處理 ---
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('[SIGNATURE] 驗證失敗');
      return res.status(403).send('Invalid signature');
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    console.log('[INCOMING BODY]', JSON.stringify(body));

    for (const event of body.events || []) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = event.message.text.trim();
        let aiText;

        if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const category = await classifyStateLog(content);
          const summary = content.slice(0, 15);
          const parsedTime = parseDateTime(content);
          const shortPhrase = await generateShortPhrase(content);

          aiText =
            `📝 補記：${parsedTime}\n` +
            `📌 狀態：${summary}\n` +
            `📂 主模組：${category.main.join(" + ") || "無"}\n` +
            `🏷️ 輔助：${category.tags.join(" + ") || "無"}\n` +
            `✨ 小語：${shortPhrase}`;

          saveLog({ type: "補記", time: parsedTime, summary, category, text: content });

        } else if (isSummaryRequest(userText)) {
          aiText = handleSummary(userText);

        } else if (isLogMessage(userText)) {
          const category = await classifyStateLog(userText);
          const summary = userText.slice(0, 15);
          const parsedTime = parseDateTime(userText);
          const shortPhrase = await generateShortPhrase(userText);

          aiText =
            `🕰️ 已記錄：${parsedTime}\n` +
            `📌 狀態：${summary}\n` +
            `📂 主模組：${category.main.join(" + ") || "無"}\n` +
            `🏷️ 輔助：${category.tags.join(" + ") || "無"}\n` +
            `\n${shortPhrase}`;

          saveLog({ type: "紀錄", time: parsedTime, summary, category, text: userText });

        } else {
          try {
            const r = await openai.responses.create({
              model: 'gpt-4o-mini',
              instructions: SYSTEM_MESSAGE || '你是一個用繁體中文回覆的貼心助理。',
              input: userText
            });
            aiText = (r.output_text || '').slice(0, 1900);
          } catch (e) {
            console.error('[OpenAI ERROR]', e);
            aiText = '我這邊忙線一下，等等再試。';
          }
        }

        await lineReply(event.replyToken, aiText);
      }
    }

    res.status(200).end();
  } catch (e) {
    console.error('[WEBHOOK ERROR]', e);
    if (!res.headersSent) res.status(500).end();
  }
}
