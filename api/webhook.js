import { createHmac } from 'node:crypto';
import OpenAI from 'openai';
import fs from 'fs';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SYSTEM_MESSAGE } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- 驗證 LINE 簽章 ---------------- */
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

/* ---------------- 紀錄存取 ---------------- */
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

function deleteLastLog() {
  if (!fs.existsSync("logs.json")) return null;
  const logs = JSON.parse(fs.readFileSync("logs.json", "utf8"));
  if (logs.length === 0) return null;
  const removed = logs.pop();
  fs.writeFileSync("logs.json", JSON.stringify(logs, null, 2));
  return removed;
}

/* ---------------- 時間解析 ---------------- */
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
    target.setMonth(parseInt(mdMatch[1], 10) - 1);
    target.setDate(parseInt(mdMatch[2], 10));
  }

  const hmMatch = text.match(/(\d{1,2})(?:點|:)(\d{1,2})?/);
  if (hmMatch) {
    target.setHours(parseInt(hmMatch[1], 10), hmMatch[2] ? parseInt(hmMatch[2], 10) : 0, 0, 0);
  }

  return target.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

/* ---------------- 判斷邏輯 ---------------- */
function isBacklogMessage(text) {
  return text.startsWith("補記");
}
function isSummaryRequest(text) {
  return text.includes("總結");
}
function looksLikeQuery(text) {
  return (
    text.endsWith("嗎？") || text.endsWith("嗎?") || text.endsWith("?") ||
    text.startsWith("幫我") || text.startsWith("告訴我") ||
    text.startsWith("查") || text.startsWith("給我") || text.startsWith("請")
  );
}


// --- 分類器（主模組 + 輔助分類 + GPT fallback）---
async function classifyStateLog(text) {
  // TODO: 在這裡放完整關鍵字分類邏輯
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

// GPT fallback (混合版)
try {
  // Step 1: 判斷是紀錄 or 對話
  const judge = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "請判斷以下輸入屬於『紀錄』還是『對話』，只回一個詞。" },
      { role: "user", content: text }
    ],
    max_tokens: 5
  });

  const decision = judge.choices[0].message.content.trim();

  // Step 2: 如果是對話 → 不存紀錄
  if (decision === "對話") {
    return { main: [], tags: ["📝 紀錄／其他"] };
  }

  // Step 3: 如果是紀錄 → 請 GPT 幫忙補分類
  const classify = await openai.chat.completions.create({
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

  return { main: [], tags: [classify.choices[0].message.content.trim()] };

} catch (e) {
  console.error("[GPT 混合分類錯誤]", e);
  return { main: [], tags: ["📝 紀錄／其他"] };
}

/* ---------------- 短語生成 ---------------- */
async function generateShortPhrase(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_MESSAGE || "你是一個熟悉 Jean 狀態的助理" },
        { role: "user", content: `請根據「我現在的狀態是：${text}」，產生一句不超過30字的自然短語。` }
      ],
      max_tokens: 50
    });
    return r.choices[0].message.content.trim();
  } catch {
    return "（狀態已記錄）";
  }
}

/* ---------------- 區段計算 ---------------- */
function splitCrossDay(start, end, state) {
  const segments = [];
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (startDate.toDateString() === endDate.toDateString()) {
    segments.push({ start, end, state });
  } else {
    const dayEnd = new Date(startDate);
    dayEnd.setHours(23, 59, 59, 999);
    segments.push({ start, end: dayEnd.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }), state });

    const nextDayStart = new Date(dayEnd.getTime() + 1000);
    segments.push({ start: nextDayStart.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }), end, state });
  }
  return segments;
}

function buildSummary(logs) {
  const result = [];
  const filtered = logs.filter(l => l.type === "紀錄" || l.type === "補記");

  for (let i = 0; i < filtered.length - 1; i++) {
    const cur = filtered[i];
    const next = filtered[i + 1];
    const curTime = new Date(cur.time);
    const nextTime = new Date(next.time);

    const segments = splitCrossDay(curTime, nextTime, cur.summary);
    segments.forEach(seg => result.push(seg));
  }

  return result.map(r =>
    `${r.start}–${r.end}｜${r.state}`
  ).join("\n");
}

function handleSummary(text) {
  const logs = loadLogs();
  if (logs.length === 0) return "目前沒有任何紀錄可供總結。";

  let filtered = [];
  const now = new Date();

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

  return "📊 總結：\n" + buildSummary(filtered);
}

/* ---------------- 路由判斷 ---------------- */
async function smartMessageRoute(userText) {
  if (isBacklogMessage(userText)) return "補記";
  if (isSummaryRequest(userText)) return "總結";
  if (looksLikeQuery(userText)) return "對話";

  const category = await classifyStateLog(userText);
  if (category.main.length > 0 || category.tags.length > 0) {
    return "紀錄";
  }

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "請判斷輸入是『紀錄』還是『對話』，只回一個詞。" },
      { role: "user", content: userText }
    ],
    max_tokens: 5
  });
  return r.choices[0].message.content.includes("紀錄") ? "紀錄" : "對話";
}

/* ---------------- LINE Reply ---------------- */
async function lineReply(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const body = JSON.stringify({ replyToken, messages: [{ type: 'text', text }] });
  const headers = {
    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
  await fetch(url, { method: 'POST', headers, body });
}

/* ---------------- 主處理 ---------------- */
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

    if (!verifyLineSignature(rawBody, signature)) return res.status(403).send('Invalid signature');

    const body = JSON.parse(rawBody.toString('utf8'));

    for (const event of body.events || []) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = event.message.text.trim();
        let aiText;

        // --- 撤銷 ---
        if (userText === "刪掉上一筆" || userText === "撤銷") {
          const removed = deleteLastLog();
          aiText = removed ? `🗑️ 已刪除上一筆：${removed.time}｜${removed.summary}` : "⚠️ 沒有紀錄可刪除。";
          await lineReply(event.replyToken, aiText);
          continue;
        }

        // --- 判斷路由 ---
        const action = await smartMessageRoute(userText);

        if (action === "補記") {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const category = await classifyStateLog(content);
          const summary = content.slice(0, 15);
          const parsedTime = parseDateTime(content);
          const shortPhrase = await generateShortPhrase(content);

          aiText = `📝 補記：${parsedTime}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ")||"無"}\n🏷️ 輔助：${category.tags.join(" + ")||"無"}\n\n${shortPhrase}`;
          saveLog({ type: "補記", time: parsedTime, summary, category, text: content });
        }
        else if (action === "總結") {
          aiText = handleSummary(userText);
        }
        else if (action === "紀錄") {
          const category = await classifyStateLog(userText);
          const summary = userText.slice(0, 15);
          const parsedTime = parseDateTime(userText);
          const shortPhrase = await generateShortPhrase(userText);

          aiText = `🕰️ 已記錄：${parsedTime}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ")||"無"}\n🏷️ 輔助：${category.tags.join(" + ")||"無"}\n\n${shortPhrase}`;
          saveLog({ type: "紀錄", time: parsedTime, summary, category, text: userText });
        }
        else { // 對話
          try {
            const r = await openai.responses.create({
              model: 'gpt-4o-mini',
              instructions: SYSTEM_MESSAGE || '你是一個用繁體中文回覆的貼心助理。',
              input: userText
            });
            aiText = (r.output_text || '').slice(0, 1900);
          } catch {
            aiText = '我這邊忙線一下，等等再試。';
          }
        }

        await lineReply(event.replyToken, aiText);
      }
    }

    res.status(200).end();
  } catch {
    if (!res.headersSent) res.status(500).end();
  }
}
