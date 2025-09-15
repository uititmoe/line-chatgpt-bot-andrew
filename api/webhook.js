import { createHmac } from "node:crypto";
import OpenAI from "openai";

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SHEET_WEBHOOK_URL } =
  process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -----------------------------
// 全域暫存（記錄、對話歷史）
// -----------------------------
let logs = [];
let chatHistory = [];

// -----------------------------
// 工具：時間處理
// -----------------------------
function nowUtcISO() {
  return new Date().toISOString();
}
function nowTaipeiDisplay() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

// -----------------------------
// Google Sheet 同步
// -----------------------------
async function syncToSheet(log) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
  } catch (e) {
    console.error("[Google Sheet 同步失敗]", e);
  }
}

// -----------------------------
// 訊息判斷
// -----------------------------
function isBacklogMessage(text) {
  return text.startsWith("補記");
}
function isSummaryRequest(text) {
  return text.includes("總結");
}
function isLogCandidate(text) {
  // 問句排除
  if (/[嗎\?？]$/.test(text)) return false;
  const nonLogPhrases = ["我覺得", "我希望", "我猜", "我認為", "可以幫", "能不能", "要不要", "是不是", "你"];
  if (nonLogPhrases.some((p) => text.startsWith(p) || text.includes(p))) return false;

  // 常見日誌動詞
  const verbs = ["起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;

  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;

  return false;
}

// -----------------------------
// 分類（含藝廊 & 辦公室的 keyword 判斷）
// -----------------------------
const galleryKeywords = ["藝廊", "展覽", "展場", "佈展", "撤展", "策展", "會計", "收據", "做網站", "架網站", "朝朝", "陸角銀", "講座", "顧展", "收展", "展品", "藝術家", "寄賣", "分潤", "對帳"];
const officeActions = ["打掃", "清理", "整理", "收納", "維護", "修繕", "補貨", "檢查"];

async function classifyStateLog(text) {
  try {
    if (galleryKeywords.some((kw) => text.includes(kw))) {
      return { main: ["A. 藝廊工作"], tags: ["🧾 行政"] };
    }
    if ((text.includes("辦公室") && officeActions.some((kw) => text.includes(kw))) || text.includes("洗衣店")) {
      return { main: ["E. 辦公室維運"], tags: ["🧹 環境整理"] };
    }

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `你是日誌分類助理。
請把輸入訊息分成：
1. 主模組（五選一：A. 藝廊工作, B. Podcast, C. 商業漫畫, D. 同人與委託, E. 辦公室維運, F. 生活日常）
2. 輔助分類（可多選：創作／交通／行政／財務／SNS／飲食／健康／社交／休息／其他）
只回 JSON，例如：
{"main":["C. 商業漫畫"], "tags":["📢 SNS／宣傳","🧾 行政"]}`,
        },
        { role: "user", content: text },
      ],
    });

    return JSON.parse(r.choices[0].message.content.trim());
  } catch (e) {
    console.error("[GPT 分類錯誤]", e);
    return { main: ["F. 生活日常"], tags: ["📝 其他"] };
  }
}

// -----------------------------
// 摘要 + 小語
// -----------------------------
async function summarizeEvent(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "將輸入壓縮成不超過15字的事件描述，去掉贅字語氣詞，語氣自然，不要加句號。" },
        { role: "user", content: text },
      ],
    });
    let s = r.choices[0].message.content.trim();
    s = s.replace(/[。！？、,.]$/, ""); // 去尾標點
    return s;
  } catch (e) {
    console.error("[GPT 摘要錯誤]", e);
    return text;
  }
}

async function generateShortPhrase(text, isBacklog = false) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 50,
      messages: [
        { role: "system", content: "你是 Jean 的 LINE 助理，熟悉他的生活狀態與語氣風格。" },
        {
          role: "user",
          content: `這是一則${isBacklog ? "補記" : "即時"}紀錄：「${text}」。請生成一句不超過30字的自然短語，語氣自然，不要照抄原文。`,
        },
      ],
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[短語生成錯誤]", e);
    return "（狀態已記錄）";
  }
}

// -----------------------------
// 總結日期範圍
// -----------------------------
function getDateRange(type) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (type === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (type === "week") {
    const day = now.getDay() || 7;
    start.setDate(now.getDate() - day + 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 7);
    end.setHours(0, 0, 0, 0);
  } else if (type === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(start.getMonth() + 1, 1);
    end.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

// -----------------------------
// LINE Reply
// -----------------------------
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
  const resp = await fetch(url, { method: "POST", headers, body });
  if (!resp.ok) console.error("[LINE Reply Error]", await resp.text());
  return resp.ok;
}

// -----------------------------
// Webhook handler
// -----------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const rawBody = Buffer.concat(chunks);
    const body = JSON.parse(rawBody.toString("utf8"));

    for (const event of body.events || []) {
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text.trim();
        let aiText = "";

        /** 補記 */
        if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const category = await classifyStateLog(content);
          const summary = await summarizeEvent(content);
          const shortPhrase = await generateShortPhrase(content, true);

          const logItem = {
            type: "backlog",
            timeISO: nowUtcISO(),
            timeDisplay: nowTaipeiDisplay(),
            summary,
            main: category.main,
            tags: category.tags,
          };
          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `📝 補記：${logItem.timeDisplay}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }

        /** 即時紀錄 */
        else if (isLogCandidate(userText)) {
          const category = await classifyStateLog(userText);
          const summary = await summarizeEvent(userText);
          const shortPhrase = await generateShortPhrase(userText, false);

          const logItem = {
            type: "instant",
            timeISO: nowUtcISO(),
            timeDisplay: nowTaipeiDisplay(),
            summary,
            main: category.main,
            tags: category.tags,
          };
          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `🕰️ 已記錄：${logItem.timeDisplay}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }

        /** 總結 */
        else if (isSummaryRequest(userText)) {
          let rangeType = "today";
          if (userText.includes("週")) rangeType = "week";
          if (userText.includes("月")) rangeType = "month";
          const { start, end } = getDateRange(rangeType);

          const rangeLogs = logs.filter((log) => {
            if (log.timeISO) {
              const t = new Date(log.timeISO);
              return t >= start && t < end;
            }
            return false;
          });

          if (rangeLogs.length === 0) {
            aiText = `📊 這${rangeType === "today" ? "天" : rangeType === "week" ? "週" : "月"}還沒有紀錄喔～`;
          } else {
            const list = rangeLogs.map((log, i) => `${i + 1}. ${log.timeDisplay}｜${log.summary}｜${log.main.join(" + ")}｜${log.tags.join(" + ") || "無"}`);
            const stats = {};
            rangeLogs.forEach((log) => log.main.forEach((m) => (stats[m] = (stats[m] || 0) + 1)));
            const statLines = Object.entries(stats).map(([k, v]) => `${k}: ${v} 筆`);
            aiText = `📊 ${rangeType === "today" ? "今日" : rangeType === "week" ? "本週" : "本月"}總結\n\n${list.join("\n")}\n\n📈 主模組統計：\n${statLines.join("\n")}`;
          }
        }

        /** 一般對話 */
        else {
          try {
            chatHistory.push({ role: "user", content: userText });
            const recentHistory = chatHistory.slice(-5);

            const r = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                { role: "system", content: "你是 Jean 的 LINE 助理，用繁體中文自然回應。" },
                ...recentHistory,
              ],
            });

            const replyText = (r.choices[0]?.message?.content || "").trim();
            chatHistory.push({ role: "assistant", content: replyText });
            aiText = replyText.slice(0, 1900);
          } catch (e) {
            console.error("[OpenAI 對話錯誤]", e);
            aiText = "我這邊忙線一下，等等再試。";
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
