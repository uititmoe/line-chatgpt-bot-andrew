import { createHmac } from "node:crypto";
import OpenAI from "openai";

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  SHEET_WEBHOOK_URL, // ✅ 在 Vercel 環境變數設定
  SYSTEM_MESSAGE,
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let logs = [];
let chatHistory = [];

/** ---------------- 工具函式 ---------------- */

// 驗證 LINE 簽章
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
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

  const resp = await fetch(url, { method: "POST", headers, body });
  const respText = await resp.text();
  console.log("[LINE REPLY]", { status: resp.status, text: respText });
  return resp.ok;
}

// 同步到 Google Sheet
async function syncToSheet(log) {
  if (!SHEET_WEBHOOK_URL) {
    console.error("❌ SHEET_WEBHOOK_URL 未設定");
    return;
  }
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
  } catch (e) {
    console.error("[同步 Google Sheet 失敗]", e);
  }
}

// 判斷訊息類型
function isBacklogMessage(text) {
  return text.startsWith("補記");
}
function isSummaryRequest(text) {
  return text.includes("總結");
}
function isLogCandidate(text) {
  const nonLogPhrases = [
    "我覺得", "我希望", "我猜", "我認為",
    "可以幫", "能不能", "要不要", "是不是", "你",
  ];
  if (nonLogPhrases.some((p) => text.startsWith(p) || text.includes(p))) return false;
  if (/[嗎\?？]$/.test(text)) return false;
  if (text.startsWith("補記") || text.includes("總結")) return false;

  const verbs = ["起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;

  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;

  return false;
}

// 總結範圍
function getDateRange(type) {
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);

  if (type === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (type === "week") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(now.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 7);
  } else if (type === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setMonth(start.getMonth() + 1);
  }
  return { start, end };
}

/** ---------------- 主處理函式 ---------------- */

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
      return res.status(403).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));

    for (const event of body.events || []) {
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text.trim();
        let aiText = "我這邊忙線一下，等等再試。";

        /** -------- 補記 -------- */
        if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const t = parseDateTimeDetailed(content);

          const category = await classifyStateLog(content);
          const summary = await summarizeEvent(content);
          const shortPhrase = await generateShortPhrase(content, true);

          const logItem = {
            type: "backlog",
            timeISO: t.iso,
            timeDisplay: t.display,
            summary,
            main: category.main,
            tags: category.tags,
          };

          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `📝 補記：${t.display}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }

        /** -------- 即時紀錄 -------- */
        else if (isLogCandidate(userText)) {
          const timeDisplay = nowTaipeiDisplay();
          const timeISO = nowUtcISO();

          const category = await classifyStateLog(userText);
          const summary = await summarizeEvent(userText);
          const shortPhrase = await generateShortPhrase(userText, false);

          const logItem = {
            type: "instant",
            timeISO,
            timeDisplay,
            summary,
            main: category.main,
            tags: category.tags,
          };

          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `🕰️ 已記錄：${timeDisplay}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }

        /** -------- 總結 -------- */
        else if (isSummaryRequest(userText)) {
          let rangeType = "today";
          let customDate = null;

          if (userText.includes("週")) {
            rangeType = "week";
          } else if (userText.includes("月")) {
            rangeType = "month";
          } else {
            const md = userText.match(/(\d{1,2})[\/\-](\d{1,2})/);
            if (md) {
              const m = parseInt(md[1], 10);
              const d = parseInt(md[2], 10);
              const y = new Date().getFullYear();
              customDate = new Date(y, m - 1, d);
              rangeType = "custom";
            }
          }

          let start, end;
          if (rangeType === "custom" && customDate) {
            start = new Date(customDate);
            start.setHours(0, 0, 0, 0);
            end = new Date(customDate);
            end.setHours(23, 59, 59, 999);
          } else {
            ({ start, end } = getDateRange(rangeType));
          }

          const rangeLogs = logs.filter((log) => {
            if (log.timeISO) {
              const t = new Date(log.timeISO);
              return t >= start && t < end;
            }
            return false;
          });

          if (rangeLogs.length === 0) {
            aiText = `📊 ${
              rangeType === "today"
                ? "今天"
                : rangeType === "week"
                ? "本週"
                : rangeType === "month"
                ? "本月"
                : `${customDate.getMonth() + 1}/${customDate.getDate()}`
            } 還沒有紀錄喔～`;
          } else {
            const list = rangeLogs.map(
              (log, i) =>
                `${i + 1}. ${log.timeDisplay}｜${log.summary}｜${log.main.join(
                  " + "
                )}｜${log.tags.join(" + ") || "無"}`
            );

            const stats = {};
            rangeLogs.forEach((log) =>
              log.main.forEach((m) => (stats[m] = (stats[m] || 0) + 1))
            );
            const statLines = Object.entries(stats).map(([k, v]) => `${k}: ${v} 筆`);

            aiText = `📊 ${
              rangeType === "today"
                ? "今日"
                : rangeType === "week"
                ? "本週"
                : rangeType === "month"
                ? "本月"
                : `${customDate.getMonth() + 1}/${customDate.getDate()}`
            } 總結\n\n${list.join("\n")}\n\n📈 主模組統計：\n${statLines.join("\n")}`;
          }
        }

        /** -------- 一般對話 -------- */
        else {
          try {
            chatHistory.push({ role: "user", content: userText });
            const recentHistory = chatHistory.slice(-5);

            const r = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: SYSTEM_MESSAGE || "你是 Jean 的 LINE 助理，用繁體中文自然回應。",
                },
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
