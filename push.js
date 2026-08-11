// Yommo instant push — called by the app when someone claims a ride / shares a photo
const crypto = require('crypto');
const PROJECT = 'yommo-5738a';
const b64u = (s) => Buffer.from(s).toString('base64url');
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const input = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sign = crypto.createSign('RSA-SHA256'); sign.update(input);
  const jwt = input + '.' + sign.sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('auth failed');
  return d.access_token;
}
function fromFs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = fromFs(f[k]); return o; }
  return null;
}
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'nope' };
    const { familyId, exceptUid, title, body } = JSON.parse(event.body || '{}');
    if (!familyId || !title || typeof familyId !== 'string' || familyId.length > 60) return { statusCode: 400, body: 'bad request' };
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await getToken(sa);
    // members of this family
    const q = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: { field: { fieldPath: 'familyIds' }, op: 'ARRAY_CONTAINS', value: { stringValue: familyId } } }, limit: 100 } })
    });
    const rows = await q.json();
    let sent = 0;
    for (const row of rows) {
      if (!row.document) continue;
      const uid = row.document.name.split('/').pop();
      if (uid === exceptUid) continue;
      const u = {}; const flds = row.document.fields || {}; for (const k in flds) u[k] = fromFs(flds[k]);
      if (u.pushOn !== true || !Array.isArray(u.pushTokens)) continue;
      for (const tk of u.pushTokens) {
        const r = await fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT + '/messages:send', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: tk, webpush: { notification: { title: String(title).slice(0, 120), body: String(body || '').slice(0, 200), icon: 'https://yommo.app/icon-192.png' }, fcm_options: { link: 'https://yommo.app/' } } } })
        });
        if (r.ok) sent++;
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + e.message };
  }
};
