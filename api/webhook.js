import { createHmac } from 'node:crypto';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN } = process.env;

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

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 收 raw body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    // 驗簽
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('[SIGNATURE] 驗證失敗');
      return res.status(403).send('Invalid signature');
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    console.log('[INCOMING BODY]', JSON.stringify(body));

    // 處理事件
    for (const event of body.events || []) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = event.message.text.trim();
        await lineReply(event.replyToken, `測試 OK：收到「${userText}」`);
      }
    }

    // 確定都處理完，再回 LINE 平台
    res.status(200).end();
  } catch (e) {
    console.error('[WEBHOOK ERROR]', e);
    if (!res.headersSent) res.status(500).end();
  }
}
