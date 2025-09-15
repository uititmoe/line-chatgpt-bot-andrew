import { createHmac } from "node:crypto";
import OpenAI from "openai";

const { 
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  SYSTEM_MESSAGE,
  SHEET_WEBHOOK_URL // 在 Vercel 設定
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- 模組級暫存（冷啟動會清空） ---
let logs = [];        // { type, timeISO, timeDisplay, summary, main[], tags[], deleted? }
let chatHistory = []; // 對話延續

// ---------------- 工具：時間 ----------------
function nowUtcISO() {
  return new Date().toISOString();
}
function nowTaipeiDisplay() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}
// 以台灣時間為基準取 now、並回傳 JS Date（實際是 UTC 時刻）
function taiwanNow() {
  const now = new Date();
  const tzOffset = 8 * 60;
  return new Date(now.getTime() + (tzOffset - now.getTimezoneOffset()) * 60000);
}

// ---------------- 驗證 LINE 簽章 ----------------
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hmac === signature;
}

// ---------------- LINE Reply ----------------
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
  if (!resp.ok) {
    const t = await resp.text();
    console.error("[LINE REPLY ERROR]", resp.status, t);
  }
  return resp.ok;
}

// ---------------- Google Sheet 同步 ----------------
async function syncToSheet(payload) {
  if (!SHEET_WEBHOOK_URL) {
    console.warn("SHEET_WEBHOOK_URL 未設定，略過同步");
    return;
  }
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[Google Sheet 同步失敗]", e);
  }
}

// ---------------- 訊息判斷 ----------------
function isBacklogMessage(text) {
  return /^補記/.test(text.trim());
}
function isSummaryRequest(text) {
  return text.includes("總結"); 
}
function isUndoRequest(text) {
  return text.includes("撤銷") || text.includes("刪除上一則");
}

function isLogCandidate(text) {
  // 問句 → 當對話
  if (/[嗎\?？]$/.test(text)) return false;

  // 非記錄語氣 → 只檢查句首，避免誤殺
  const nonLogStarts = ["我覺得", "我希望", "我猜", "我認為", "可以幫", "能不能", "要不要", "是不是"];
  if (nonLogStarts.some((p) => text.startsWith(p))) return false;

  // 排除特指指令
  if (text.startsWith("補記") || text.includes("總結") || text.startsWith("撤銷")) return false;

  // 常見動詞
  const verbs = ["起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備"];
  if (verbs.some((v) => text.includes(v))) return true;

  // 常見敘述語氣
  if (/^我/.test(text) || text.includes("正在") || text.includes("剛")) return true;

  return false;
}

// ---------------- 補記時間解析 ----------------
/**
 * 解析補記用時間：
 *  - 支援：今天 / 昨天 / 前天 / 明天、mm/dd 或 mm-dd、HH:MM、H點半
 *  - 若含「約 / 大約」且無日期 → 原樣回傳（display 保留，iso=null）
 * 回傳：{ display: string, iso: string|null }
 */
function parseDateTimeDetailed(text) {
  const now = new Date();
  const tzOffset = 8 * 60;
  const taiwanNowDate = new Date(
    now.getTime() + (tzOffset - now.getTimezoneOffset()) * 60000
  );

  // 模糊時間：直接保留原樣
  if (/約|大約/.test(text)) {
    const approx = text.match(/約.*$/)?.[0] || text;
    return { display: approx.trim(), iso: null };
  }

  // 預設為今天
  let y = taiwanNowDate.getFullYear();
  let m = taiwanNowDate.getMonth() + 1;
  let d = taiwanNowDate.getDate();
  let hadDate = false;

  if (/今天/.test(text)) {
    hadDate = true;
  } else if (/昨天/.test(text)) {
    const t = new Date(taiwanNowDate);
    t.setDate(t.getDate() - 1);
    y = t.getFullYear(); m = t.getMonth() + 1; d = t.getDate(); hadDate = true;
  } else if (/前天/.test(text)) {
    const t = new Date(taiwanNowDate);
    t.setDate(t.getDate() - 2);
    y = t.getFullYear(); m = t.getMonth() + 1; d = t.getDate(); hadDate = true;
  } else if (/明天/.test(text)) {
    const t = new Date(taiwanNowDate);
    t.setDate(t.getDate() + 1);
    y = t.getFullYear(); m = t.getMonth() + 1; d = t.getDate(); hadDate = true;
  }

  // mm/dd 或 mm-dd
  const md = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (md) {
    m = parseInt(md[1], 10);
    d = parseInt(md[2], 10);
    hadDate = true;
  }

  // 時分
  let hh = 0, mm = 0;
  const hm = text.match(/(\d{1,2})(?:[:點](\d{1,2})?)/);
  if (hm) {
    hh = parseInt(hm[1], 10);
    if (hm[2]) mm = parseInt(hm[2], 10);
    else if (text.includes("半")) mm = 30;
  }

  // 無法判斷日期 → 保留原樣
  if (!hadDate) {
    return { display: text.trim(), iso: null };
  }

  const iso = new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`
  ).toISOString();

  const display = `${m}/${d} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return { display, iso };
}

// ---------------- 分類（關鍵字 + GPT fallback） ----------------
const galleryKeywords = [
  "藝廊", "展覽", "展場", "佈展", "撤展", "策展", "會計", "收據",
  "做網站", "架網站", "朝朝", "陸角銀", "講座",
  "顧展", "收展", "展品", "藝術家", "寄賣", "分潤", "對帳"
];
const officeActions = ["打掃", "清理", "整理", "收納", "維護", "修繕", "補貨", "檢查"];

async function classifyStateLog(text) {
  try {
    // 先用 keyword 判斷（狹義）
    if (galleryKeywords.some((kw) => text.includes(kw))) {
      return { main: ["A. 藝廊工作"], tags: ["🧾 行政"] };
    }
    if ((text.includes("辦公室") && officeActions.some((kw) => text.includes(kw))) || text.includes("洗衣店")) {
      return { main: ["E. 辦公室維運"], tags: ["🧹 環境整理"] };
    }

    // 其他交給 GPT fallback
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
⚠️ 注意：
- 僅在輸入同時包含「辦公室」+（打掃、清理、整理、收納、維護、修繕、補貨、檢查）等處理辦公室事務時，才算 E. 辦公室維運。
- 單純提到「到辦公室、在辦公室」但沒有維護行為，要分類為 F. 生活日常。
- 「洗衣店」只有搭配維護相關行為才算辦公室維運。`
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

// ---------------- 摘要 + 小語 ----------------
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

/** 小語（SYSTEM_MESSAGE + 規則混合版；支援補記語氣） */
async function generateShortPhrase(text, isBacklog = false) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",  // ✅ 用主模型，不要 mini，保證語氣多變
      messages: [
        {
          role: "system",
          content:
            (SYSTEM_MESSAGE || "你是 Jean 的 LINE 助理，用繁體中文自然回應。") +
            `\n任務指令：
請根據輸入內容生成一句不超過 50 字的短語。

規則：
- 即時紀錄 → 用現在進行式，像陪伴聊天。
- 補記 → 用已完成/回顧語氣，避免「正在、準備」。
- 語氣自然，像熟人，輕鬆幽默即可。
- 可以有簡單鼓勵、心情回應、提醒或小知識。
- 避免浮誇、網路流行語。
- 句尾保持自然標點（句號、驚嘆號、問號均可），偶爾可使用表情符號。
- 短語長度可在 10–50 字之間變化。
- 句型保持多樣化，不要每次都以相同字詞（如「開始」「準備」）開頭。
- 可以偶爾加入隱性的情緒或效果描述（例如「空間清爽多了」「看來會很忙碌」）。`,
        },
        {
          role: "user",
          content: isBacklog
            ? `這是一則補記：${text}`
            : `這是一則即時紀錄：${text}`,
        },
      ],
      max_tokens: 80, // 保險範圍，足夠生成 50 字左右中文
      temperature: 0.7,
    });

    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[短語生成錯誤]", e);
    return "（狀態已記錄）";
  }
}

// ---------------- 總結範圍（依台灣時間） ----------------
function getDateRange(type) {
  const nowTW = taiwanNow();
  let start = new Date(nowTW);
  let end = new Date(nowTW);

  if (type === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (type === "week") {
    // 週一為一週開始
    const day = start.getDay() || 7; // 1..7
    start.setDate(start.getDate() - (day - 1));
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (type === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setMonth(start.getMonth() + 1);
    end.setDate(0); // 上月最後一天＝本月末
    end.setHours(23, 59, 59, 999);
  }
  return { start, end };
}

// =============================================================
// Webhook handler
// =============================================================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 收 raw body（簽章要用 raw）
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

    for (const event of body.events || []) {
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text.trim();
        let aiText = "我這邊忙線一下，等等再試。";


        // -------- 1) 撤銷（支援：撤銷 <時間戳>；否則撤銷最後一筆） --------
        if (isUndoRequest(userText)) {
          let targetLog = null;

          // 解析「撤銷 <時間字串>」
          const parts = userText.split(" ");
          if (parts.length > 1) {
            const targetTime = parts[1].trim();
            targetLog = logs.find(
              (log) =>
                !log.deleted &&
                (log.timeISO === targetTime || log.timeDisplay === targetTime)
            );
          }

          // 沒指定 → 找最後一筆未刪除
          if (!targetLog && logs.length > 0) {
            targetLog = [...logs].reverse().find((log) => !log.deleted);
          }

          if (targetLog) {
            targetLog.deleted = true; // 統一軟刪除（總結時會排除）

            // 同步刪除到 Google Sheet（Apps Script 端需支援 action=delete）
            await syncToSheet({
              action: "delete",
              timeISO: targetLog.timeISO,
              timeDisplay: targetLog.timeDisplay,
            });

            aiText = `↩️ 已撤銷紀錄：${targetLog.timeDisplay || ""}｜${targetLog.summary || "(無摘要)"}`;
          } else {
            aiText = "⚠️ 沒有可撤銷的紀錄";
          }
        }
          

        // -------- 2) 補記 --------
        else if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const t = parseDateTimeDetailed(content); // { display, iso }

          const category = await classifyStateLog(content);
          const summary = await summarizeEvent(content);
          const shortPhrase = await generateShortPhrase(content, true);

          const logItem = {
            type: "backlog",
            timeISO: t.iso || null,  // 可能為 null（約/大約…）
            timeDisplay: t.display,
            summary,
            main: category.main,
            tags: category.tags,
          };
          logs.push(logItem);

          // 同步新增
          await syncToSheet({
            action: "append",
            ...logItem,
          });

          aiText = `📝 補記：${logItem.timeDisplay}\n` +
                   `📌 狀態：${summary}\n` +
                   `📂 主模組：${category.main.join(" + ") || "無"}\n` +
                   `🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n` +
                   `${shortPhrase}`;
        }
        
        // -------- 3) 即時紀錄 --------
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

          // 同步新增
          await syncToSheet({
            action: "append",
            ...logItem,
          });

          aiText = `🕰️ 已記錄：${timeDisplay}\n` +
                   `📌 狀態：${summary}\n` +
                   `📂 主模組：${category.main.join(" + ") || "無"}\n` +
                   `🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n` +
                   `${shortPhrase}`;
        }

        // -------- 4) 總結（今日 / 本週 / 本月 / 指定單日） --------
        else if (isSummaryRequest(userText)) {
          let rangeType = "today";
          let customDate = null;
          let mdMatch = null;

          if (userText.includes("週")) rangeType = "week";
          else if (userText.includes("月")) rangeType = "month";
          else {
            // 支援 "9/15 總結" 或 "09-15 總結"
            mdMatch = userText.match(/(\d{1,2})[\/\-](\d{1,2})/);
            if (mdMatch) {
              const y = new Date().getFullYear();
              const m = parseInt(mdMatch[1], 10);
              const d = parseInt(mdMatch[2], 10);
              customDate = new Date(y, m - 1, d);
              rangeType = "custom";
            }
          }

          // 取得範圍（以台灣時間）
          let start, end;
          if (rangeType === "custom" && customDate) {
            start = new Date(customDate); start.setHours(0, 0, 0, 0);
            end   = new Date(customDate); end.setHours(23, 59, 59, 999);
          } else {
            ({ start, end } = getDateRange(rangeType));
          }

          // 過濾範圍（排除撤銷、無 ISO 的模糊補記）
          const rangeLogs = logs.filter((log) => {
            if (log.deleted || !log.timeISO) return false;
            const t = new Date(log.timeISO);
            return t >= start && t <= end;
          });

          const title =
            rangeType === "custom" && customDate
              ? `${customDate.getMonth() + 1}/${customDate.getDate()} 單日總結`
              : rangeType === "today"
              ? "今日總結"
              : rangeType === "week"
              ? "本週總結"
              : "本月總結";

          if (rangeLogs.length === 0) {
            aiText = `📊 ${title}\n（沒有紀錄）`;
          } else {
            // 清單
            const list = rangeLogs.map(
              (log, i) =>
                `${i + 1}. ${log.timeDisplay}｜${log.summary}｜${log.main.join(" + ")}｜${log.tags.join(" + ") || "無"}`
            );

            // 主模組統計
            const stats = {};
            rangeLogs.forEach((log) => {
              log.main.forEach((m) => (stats[m] = (stats[m] || 0) + 1));
            });
            const statLines = Object.entries(stats).map(([k, v]) => `${k}: ${v} 筆`);

            aiText = `📊 ${title}\n\n${list.join("\n")}\n\n📈 主模組統計：\n${statLines.join("\n")}`;
          }
        }

        // -------- 5) 一般對話（延續模式） --------
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

            const replyText = (r.choices?.[0]?.message?.content || "").trim();
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
