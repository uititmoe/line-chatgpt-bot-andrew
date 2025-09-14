import { createHmac } from "node:crypto";
import OpenAI from "openai";

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SYSTEM_MESSAGE } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** 驗證 LINE 簽章 */
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  return hmac === signature;
}

/** 判斷訊息類型 */
function isBacklogMessage(text) {
  return text.startsWith("補記");
}
function isSummaryRequest(text) {
  return text.includes("總結");
}
function isLogCandidate(text) {
  if (/[嗎\?？]$/.test(text)) return false;
  if (text.startsWith("補記") || text.includes("總結")) return false;
  const verbs = ["起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;
  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;
  return false;
}

/** -------- 修改新增：補記用時間解析 -------- */
function parseDateTime(text) {
  const now = new Date();
  const tzOffset = 8 * 60;
  const taiwanNow = new Date(now.getTime() + (tzOffset - now.getTimezoneOffset()) * 60000);
  let target = new Date(taiwanNow);
  let hasApprox = false;

  if (/約|大約/.test(text)) {
    return text.match(/約.+/)?.[0] || text;
  }
  if (/昨天/.test(text)) {
    target.setDate(taiwanNow.getDate() - 1);
  } else if (/前天/.test(text)) {
    target.setDate(taiwanNow.getDate() - 2);
  } else if (/明天/.test(text)) {
    target.setDate(taiwanNow.getDate() + 1);
  } else if (/(\d{1,2})[\/\-](\d{1,2})/.test(text)) {
    const [_, m, d] = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
    target.setMonth(parseInt(m) - 1);
    target.setDate(parseInt(d));
  }
  if (/(\d{1,2}):(\d{2})/.test(text)) {
    const [_, h, mi] = text.match(/(\d{1,2}):(\d{2})/);
    target.setHours(parseInt(h));
    target.setMinutes(parseInt(mi));
  }
  const base = target.toLocaleString("zh-TW", { timeZone: "UTC" });
  return hasApprox ? `約 ${base}` : base;
}

/** 分類（主模組＋輔助），沒命中 → fallback */
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
2. 輔助分類（可多選：創作／行政／財務／SNS／飲食／健康／社交／休息／交通／其他）

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

/** 摘要（避免照抄原文） */
async function summarizeEvent(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是日誌摘要助理。
請將輸入文字壓縮成一行簡短的事件描述（20字內），避免口語化和贅字。
只輸出簡潔描述，不要加評論。`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.3,
    });

    let result = r.choices[0].message.content.trim();

    // 🔧 後處理：移除最後的句號（中/英文/全形/半形）
    result = result.replace(/\s+$/g, "");
    result = result.replace(/[。.!！?？]$/, "");

    return result;
  } catch (e) {
    console.error("[GPT 摘要錯誤]", e);
    return text;  // 出錯時至少回原文，不會卡住
  }
}

/** 小語（30 字內自然短語） */
async function generateShortPhrase(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_MESSAGE || "你是一個熟悉 Jean 狀態的助理" },
        {
          role: "user",
          content: `請根據「我現在的狀態是：${text}」，產生一句不超過30字的自然短語。語氣自然，像熟人聊天，避免浮誇或網路流行語，要有摘要感。`,
        },
      ],
      max_tokens: 50,
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[短語生成錯誤]", e);
    return "（狀態已記錄）";
  }
}

/** LINE Reply */
async function lineReply(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = JSON.stringify({ replyToken, messages: [{ type: "text", text }] });
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

/** 主處理 */
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
        let aiText = "";

        /** -------- 補記 -------- */
        if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const parsedTime = parseDateTime(content);
          const category = await classifyStateLog(content);
          const summary = await summarizeEvent(content);
          const shortPhrase = await generateShortPhrase(content);

          aiText = `📝 補記：${parsedTime}
📌 狀態：${summary}
📂 主模組：${category.main.join(" + ") || "無"}
🏷️ 輔助：${category.tags.join(" + ") || "無"}

${shortPhrase}`;
        }
        /** -------- 即時紀錄 -------- */
        else if (isLogCandidate(userText)) {
          const parsedTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
          const category = await classifyStateLog(userText);
          const summary = await summarizeEvent(userText);
          const shortPhrase = await generateShortPhrase(userText);

          aiText = `🕰️ 已記錄：${parsedTime}
📌 狀態：${summary}
📂 主模組：${category.main.join(" + ") || "無"}
🏷️ 輔助：${category.tags.join(" + ") || "無"}

${shortPhrase}`;
        }
        /** -------- 總結 -------- */
        else if (isSummaryRequest(userText)) {
          aiText = "📊 總結功能尚在開發中";
        }
        /** -------- 一般對話 -------- */
        else {
          try {
            const r = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                { role: "system", content: "你是 Jean 的 LINE 助理，用繁體中文自然回應。" },
                { role: "user", content: userText },
              ],
            });
            aiText = r.choices[0].message.content.slice(0, 1900);
          } catch (e) {
            console.error("[OpenAI ERROR]", e);
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
