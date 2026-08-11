// Yommo email reminders — runs hourly via cron-job.org
const crypto = require('crypto');
const PROJECT = 'yommo-5738a';
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const LEADS = { '1h': 3600e3, '1d': 86400e3, '2d': 172800e3 };
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
  if (!d.access_token) throw new Error('auth failed: ' + JSON.stringify(d));
  return d.access_token;
}
function fromFs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
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
async function claimOnce(token, key) {
  // atomic create — fails with 409 if another run already sent this one
  const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/reminders_sent?documentId=' + key;
  const r = await fetch(url, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { at: { integerValue: String(Date.now()) } } })
  });
  return r.status === 200;
}
function epochFor(dateISO, time) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = (time || '09:00').split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(guess));
    const mch = p.match(/(\d+)\/(\d+)\/(\d+),? (\d+):(\d+)/);
    if (!mch) break;
    const asUTC = Date.UTC(+mch[3], +mch[1] - 1, +mch[2], +mch[4] % 24, +mch[5]);
    guess += Date.UTC(y, m - 1, d, hh, mm) - asUTC;
  }
  return guess;
}
function occurrences(ev, now) {
  const out = [];
  if (!ev.dateISO) return out;
  if (ev.repeat === 'weekly') {
    let d = new Date(ev.dateISO + 'T00:00:00Z');
    const horizon = now + 4 * 86400e3;
    for (let i = 0; i < 60; i++) {
      const iso = d.toISOString().slice(0, 10);
      const start = epochFor(iso, ev.time);
      if (start > now - 3600e3 && start < horizon) out.push({ iso, start });
      if (start >= horizon) break;
      d = new Date(d.getTime() + 7 * 86400e3);
    }
  } else {
    out.push({ iso: ev.dateISO, start: epochFor(ev.dateISO, ev.time) });
  }
  return out;
}
const EMOJI = { game: '\u26bd', practice: '\ud83c\udfc3', medical: '\ud83e\ude7a', birthday: '\ud83c\udf82', school: '\ud83c\udfeb', recital: '\ud83c\udfb5', family: '\ud83c\udfe0', other: '\ud83d\udcc5' };
function emailFor(lang, ev, occ, famName) {
  const es = lang === 'es';
  const d = new Date(occ.start);
  const when = d.toLocaleString(es ? 'es-MX' : 'en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: ev.time ? 'numeric' : undefined, minute: ev.time ? '2-digit' : undefined });
  const dirs = ev.location ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.location) : null;
  const subject = (es ? '\ud83d\udce3 \u00a1Yo! Est\u00e9n ah\u00ed \u2014 ' : '\ud83d\udce3 Yo! Be there \u2014 ') + ev.title;
  const html = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#FFF8EE;border-radius:16px;overflow:hidden;border:1px solid #EFE6D8">'
    + '<div style="background:#3B2A4E;color:#fff;padding:18px 22px;font-size:22px;font-weight:800">Yommo<span style="color:#FFB13D">!</span></div>'
    + '<div style="padding:22px">'
    + '<div style="font-size:13px;font-weight:700;color:#7A6C8C;text-transform:uppercase;letter-spacing:.05em">' + (es ? 'Recordatorio \u00b7 familia ' : 'Reminder \u00b7 ') + (famName || '') + (es ? '' : ' family') + '</div>'
    + '<div style="font-size:20px;font-weight:800;color:#3B2A4E;margin-top:8px">' + (EMOJI[ev.type] || '\ud83d\udcc5') + ' ' + ev.title + '</div>'
    + '<div style="font-size:15px;color:#3B2A4E;margin-top:6px;font-weight:600">' + when + '</div>'
    + (ev.location ? '<div style="font-size:14px;color:#7A6C8C;margin-top:4px">\ud83d\udccd ' + ev.location + '</div>' : '')
    + (ev.needsCover ? (ev.coveredBy
        ? '<div style="font-size:14px;font-weight:700;color:#3E8E6C;margin-top:8px">\ud83d\ude97 ' + (es ? ev.coveredBy.name + ' se encarga \u2713' : ev.coveredBy.name + "'s got it \u2713") + '</div>'
        : '<div style="font-size:14px;font-weight:800;color:#8a2a20;background:#FFD9D4;border-radius:10px;padding:9px 12px;margin-top:10px">\ud83d\ude97 ' + (es ? '\u00a1Nadie se ha encargado todav\u00eda! Abre Yommo y toca \u270b' : "Nobody's claimed this yet \u2014 open Yommo and tap \u270b") + '</div>') : '')
    + (dirs ? '<a href="' + dirs + '" style="display:inline-block;margin-top:14px;background:#FFB13D;color:#3B2A4E;font-weight:800;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px">' + (es ? '\ud83d\udccd C\u00f3mo llegar' : '\ud83d\udccd Directions') + '</a>' : '')
    + '<div style="margin-top:18px;font-size:12px;color:#9C8BB5">' + (es ? 'Est\u00e9n ah\u00ed. Donde sea. \u00b7 yommo.app' : 'Be there. Anywhere. \u00b7 yommo.app') + '</div>'
    + '</div></div>';
  return { subject, html };
}
exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    if (qs.key !== process.env.CRON_SECRET) return { statusCode: 401, body: 'nope' };
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await getToken(sa);
    const now = Date.now();
    const [families, users, teams] = await Promise.all([listAll(token, 'families'), listAll(token, 'users'), listAll(token, 'teams')]);
    const teamById = {}; teams.forEach(t => teamById[t.__id] = t);
    const byFam = {};
    users.forEach(u => {
      const ids = (u.familyIds && u.familyIds.length ? u.familyIds : (u.familyId ? [u.familyId] : []));
      ids.forEach(fid => (byFam[fid] = byFam[fid] || []).push(u));
    });
    // founder signup alerts
    let signupAlerts = 0;
    if (process.env.FOUNDER_EMAIL) {
      for (const u of users) {
        const key = ('signup_' + u.__id).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!(await claimOnce(token, key))) continue;
        const html = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#FFF8EE;border-radius:16px;overflow:hidden;border:1px solid #EFE6D8">'
          + '<div style="background:#3B2A4E;color:#fff;padding:18px 22px;font-size:22px;font-weight:800">Yommo<span style="color:#FFB13D">!</span> <span style="font-size:13px;color:#CBBFDD">founder alert</span></div>'
          + '<div style="padding:22px"><div style="font-size:18px;font-weight:800;color:#3B2A4E">\ud83c\udf89 New signup</div>'
          + '<div style="font-size:15px;color:#3B2A4E;margin-top:8px;font-weight:600">' + (u.name || 'No name') + '</div>'
          + '<div style="font-size:14px;color:#7A6C8C;margin-top:2px">' + (u.email || 'no email') + '</div>'
          + '<div style="font-size:12px;color:#9C8BB5;margin-top:14px">Total accounts: ' + users.length + '</div></div></div>';
        const r0 = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Yommo! <reminders@yommo.app>', to: [process.env.FOUNDER_EMAIL], subject: '\ud83c\udf89 New Yommo signup: ' + (u.name || u.email || u.__id), html })
        });
        if (r0.ok) signupAlerts++;
      }
    }
    let sent = 0, checked = 0, pushed = 0;
    for (const fam of families) {
      const recipients = (byFam[fam.__id] || []).filter(u => u.email && u.remindersOn !== false);
      if (!recipients.length) continue;
      let famEvents = (fam.events || []);
      (fam.teamIds || []).forEach(tid => {
        const tm = teamById[tid];
        if (tm) famEvents = famEvents.concat((tm.events || []).map(e => Object.assign({}, e, { title: '[' + tm.name + '] ' + e.title })));
      });
      (fam.members || []).forEach(m => {
        if (!m.bday || !/^\d{4}-\d{2}-\d{2}$/.test(m.bday)) return;
        const nowD = new Date(now); const yr = nowD.getUTCFullYear();
        const [by, bm, bd] = m.bday.split('-').map(Number);
        let iso = yr + '-' + String(bm).padStart(2, '0') + '-' + String(bd).padStart(2, '0');
        if (new Date(iso + 'T23:59:59Z').getTime() < now) iso = (yr + 1) + iso.slice(4);
        famEvents = famEvents.concat([{ id: 'bday-' + (m.id || m.name), title: m.name + ' \ud83c\udf82', dateISO: iso, time: '09:00', location: null, type: 'birthday' }]);
      });
      for (const ev of famEvents) {
        for (const occ of occurrences(ev, now)) {
          checked++;
          for (const u of recipients) {
            const lead = LEADS[u.lead] || LEADS['1d'];
            const delta = occ.start - now;
            if (delta <= 0 || delta > lead) continue;
            const key = (u.__id + '_' + ev.id + '_' + occ.iso).replace(/[^a-zA-Z0-9_-]/g, '');
            if (!(await claimOnce(token, key))) continue;
            const { subject, html } = emailFor(u.lang || 'en', ev, occ, fam.name);
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: 'Yommo! <reminders@yommo.app>', to: [u.email], subject, html })
            });
            if (r.ok) sent++;
            if (u.pushOn === true && Array.isArray(u.pushTokens)) {
              const dP = new Date(occ.start);
              const whenP = dP.toLocaleString(u.lang === 'es' ? 'es-MX' : 'en-US', { timeZone: TZ, weekday: 'long', hour: ev.time ? 'numeric' : undefined, minute: ev.time ? '2-digit' : undefined });
              for (const tk of u.pushTokens) {
                try {
                  const pr = await fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT + '/messages:send', {
                    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: { token: tk, webpush: { notification: { title: subject, body: whenP + (ev.location ? ' \u00b7 \ud83d\udccd ' + ev.location : '') + (ev.pickup ? ' \u00b7 \ud83d\ude97 ' + ev.pickup : ''), icon: 'https://yommo.app/icon-192.png' }, fcm_options: { link: 'https://yommo.app/' } } } })
                  });
                  if (pr.ok) pushed++;
                } catch (e2) {}
              }
            }
          }
        }
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, families: families.length, users: users.length, occurrencesChecked: checked, emailsSent: sent, pushesSent: pushed, signupAlerts }) };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + e.message };
  }
};
