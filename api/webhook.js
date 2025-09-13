import { createHmac } from 'node:crypto';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN } = process.env;

// 驗證簽章
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const h = createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return h === signature;
}

// Reply API
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

// Push API（測試用）
async function linePush(to, text) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const body = JSON.stringify({
    to,
    messages: [{ type: 'text', text }]
  });
  const headers = {
    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  console.log('[LINE PUSH] Request', body);

  const resp = await fetch(url, { method: 'POST', headers, body });
  const respText = await resp.text();
  console.log('[LINE PUSH] Response', { status: resp.status, text: respText });

  return resp.ok;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 先回 200，避免 LINE 判定逾時
    res.status(200).end();

    // 收 raw body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    console.log('[ENV CHECK]', {
      hasSecret: !!LINE_CHANNEL_SECRET,
      hasToken: !!LINE_CHANNEL_ACCESS_TOKEN
    });

    const okSig = verifyLineSignature(rawBody, signature);
    console.log('[SIGNATURE]', { okSig, signaturePresent: !!signature });
    if (!okSig) return;

    const body = JSON.parse(rawBody.toString('utf8'));
    console.log('[INCOMING BODY]', JSON.stringify(body));

    for (const event of body.events || []) {
      console.log('[EVENT]', { type: event.type, msgType: event.message?.type });

      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = (event.message.text || '').trim();

        // 測試 Reply
        await lineReply(event.replyToken, `測試 OK：收到「${userText}」`);

        // 測試 Push（使用 source.userId）
        await linePush(event.source.userId, `PUSH 驗證：${new Date().toLocaleString()}`);
      }
    }
  } catch (e) {
    console.error('[WEBHOOK FATAL]', e);
  }
}
