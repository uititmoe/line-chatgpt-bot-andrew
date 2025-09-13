import { createHmac } from "crypto";
import OpenAI from "openai";

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY, SYSTEM_MESSAGE } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** 驗證 LINE 簽章 */
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  return hmac === signature;
}

/** 呼叫 LINE Reply API */
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

/** 判斷訊息類型 */
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
  const verbs = ["起床", "開始", "結束", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;

  // 常見狀態語氣
  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;

  return false;
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

/** 摘要（避免照抄原文） */
async function summarizeEvent(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[GPT 摘要錯誤]", e);
    return text; // fallback：出錯時直接回原文
  }
}

/** 產生小語 */
async function generateShortPhrase(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是使用者 Jean 的語義同步助理。
請根據輸入內容，生成一句不超過 30 字的自然短語。
語氣自然，像熟人對話，可以輕微幽默或鼓勵。`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 50,
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[GPT 小語錯誤]", e);
    return "（狀態已記錄）";
  }
}

/** 主 Handler */
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
        console.log("[DEBUG] 收到訊息：", userText);

        let aiText = "我這邊忙線一下，等等再試。";

        if (isBacklogMessage(userText)) {
          const parsedTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
          const category = await classifyStateLog(userText);
          const shortPhrase = await generateShortPhrase(userText);
          aiText = `📝 補記：${parsedTime}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;

        } else if (isSummaryRequest(userText)) {
          aiText = "📊 總結功能（可加上統計，但此處略）";

        } else if (isLogCandidate(userText)) {
          const category = await classifyStateLog(userText);
          const summary = await summarizeEvent(userText);
          const parsedTime = parseDateTime(userText);
          const shortPhrase = await generateShortPhrase(userText);
          
          aiText = `🕰️ 已記錄：${parsedTime}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        } else {
          try {
            const r = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                { role: "system", content: SYSTEM_MESSAGE || "你是一個用繁體中文回覆的貼心助理。" },
                { role: "user", content: userText },
              ],
            });
            aiText = r.choices[0].message.content.trim();
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
