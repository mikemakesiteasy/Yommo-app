// Yommo founder stats — private, self-owned analytics (no third-party trackers)
const crypto = require('crypto');
const PROJECT = 'yommo-5738a';
const b64u = (s) => Buffer.from(s).toString('base64url');
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const input = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
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
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = fromFs(f[k]); return o; }
  return null;
}
async function listAll(token, coll) {
  const out = []; let pageToken = '';
  do {
    const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/' + coll + '?pageSize=300' + (pageToken ? '&pageToken=' + pageToken : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    (d.documents || []).forEach(doc => {
      const o = {}; const f = doc.fields || {}; for (const k in f) o[k] = fromFs(f[k]);
      o.__id = doc.name.split('/').pop(); out.push(o);
    });
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}
exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    if (qs.key !== process.env.CRON_SECRET) return { statusCode: 401, body: 'nope' };
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await getToken(sa);
    const [users, fams, teams] = await Promise.all([listAll(token, 'users'), listAll(token, 'families'), listAll(token, 'teams')]);
    const now = Date.now();
    const active = (ms) => users.filter(u => typeof u.lastActive === 'number' && now - u.lastActive < ms).length;
    let events = 0, rides = 0, ridesClaimed = 0, tasks = 0, members = 0;
    for (const fam of fams) {
      const evs = Array.isArray(fam.events) ? fam.events : [];
      events += evs.length;
      for (const ev of evs) { if (ev && ev.needsRide) { rides++; if (ev.rideBy) ridesClaimed++; } }
      tasks += Array.isArray(fam.tasks) ? fam.tasks.length : 0;
      members += Array.isArray(fam.members) ? fam.members.length : 0;
    }
    let teamEvents = 0;
    for (const t of teams) teamEvents += Array.isArray(t.events) ? t.events.length : 0;
    const es = users.filter(u => u.lang === 'es').length;
    const push = users.filter(u => u.pushOn === true).length;
    const rows = [
      ['\ud83d\udc65 Accounts', users.length],
      ['\ud83c\udfe0 Families', fams.length],
      ['\ud83e\uddd2 Family members on boards', members],
      ['\u26a1 Active today', active(864e5)],
      ['\ud83d\udcc6 Active this week', active(7 * 864e5)],
      ['\ud83d\udcc8 Active this month', active(30 * 864e5)],
      ['\ud83d\uddd3\ufe0f Events created', events],
      ['\u2705 Tasks created', tasks],
      ['\ud83d\ude97 Ride requests (claimed)', rides + ' (' + ridesClaimed + ')'],
      ['\ud83c\udfdf\ufe0f Teams', teams.length],
      ['\ud83c\udfdf\ufe0f Team events posted', teamEvents],
      ['\ud83c\uddea\ud83c\uddf8 Accounts in Espa\u00f1ol', es + ' of ' + users.length],
      ['\ud83d\udd14 Push notifications on', push]
    ];
    if (qs.format === 'json') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(rows.map(r => [r[0].replace(/[^A-Za-z ()]/g, '').trim(), r[1]]))) };
    }
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Yommo! Stats</title></head>'
      + '<body style="font-family:-apple-system,Segoe UI,sans-serif;background:#FFF8EE;color:#3B2A4E;max-width:520px;margin:0 auto;padding:28px 18px">'
      + '<h1 style="font-size:26px;margin:0 0 4px">Yommo<span style="color:#FFB13D">!</span> founder stats</h1>'
      + '<div style="color:#9C8BB5;font-size:13px;margin-bottom:18px">' + new Date().toLocaleString('en-US', { timeZone: process.env.TIMEZONE || 'America/Los_Angeles' }) + ' \u00b7 counted from your own database \u00b7 no trackers</div>'
      + rows.map(r => '<div style="display:flex;justify-content:space-between;align-items:baseline;background:#fff;border:1.5px solid #EFE6D8;border-radius:14px;padding:12px 16px;margin-bottom:8px"><span style="font-size:14px;font-weight:700">' + r[0] + '</span><span style="font-size:20px;font-weight:800">' + r[1] + '</span></div>').join('')
      + '</body></html>';
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: html };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + e.message };
  }
};
