// 毎朝の自動日締め。Vercel Cron から呼ばれる。
// 押し忘れた日を拾うだけで、すでに売上が入っている営業日は上書きしない。

import handler from './timecard.js';

export default function autoClose(req, res) {
  req.query = Object.assign({}, req.query, { action: 'autoClose' });
  req.method = 'GET';
  return handler(req, res);
}

