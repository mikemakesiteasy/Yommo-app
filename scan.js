// Yommo Schedule Scanner — server side (keeps the Anthropic key off the client)
const WEB_API_KEY = 'AIzaSyBO65kqJ3dWQsq1G4Gj4QjygFo0xCzNv7U'; // Firebase public web key, used only to verify logins
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  try {
    if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, body: 'ANTHROPIC_API_KEY is not set' };
    const { idToken, mime, b64 } = JSON.parse(event.body || '{}');
    if (!idToken || !mime || !b64) return { statusCode: 400, body: 'missing fields' };
    // only signed-in Yommo users may spend scanner credits
    const v = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    const vd = await v.json();
    if (!vd.users || !vd.users.length) return { statusCode: 401, body: 'not signed in' };
    const block = mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mime, data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
    const todayISO = new Date().toISOString().slice(0, 10);
    const prompt = 'You are the schedule scanner inside Yommo!, a family app. Today\'s date is ' + todayISO + '. Extract every event from this schedule.\n'
      + 'Respond with ONLY a JSON object, no markdown fences, no other text, exactly:\n'
      + '{"team_or_context":"short description or null","events":[{"title":"short name","date_iso":"YYYY-MM-DD if determinable (assume nearest sensible upcoming year), else null","date_raw":"the date exactly as written, or null","time":"HH:MM 24h if determinable, else null","location":"place or null","type":"one of: game, soccer, football, basketball, baseball, softball, volleyball, tennis, hockey, cheer, practice, sports, swim, dance, recital, lesson, school, medical, rx, dentist, therapy, vet, birthday, party, church, work, travel, meal, playdate, appointment, family, other. Use cheer for cheerleading/drill-team/spirit; dance for dance class or recital-style dance; rx for prescription or pharmacy pickup; dentist for dental; therapy for counseling/PT/speech; sports for a sport other than the listed ones; lesson for tutoring/music/academic lessons; appointment as a general fallback before other"}]}\n'
      + 'Include every event you can find. If unclear, include what you can with nulls. If no schedule, return {"team_or_context":null,"events":[]}.';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }] })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 502, body: 'AI error: ' + (data.error.message || 'request failed') };
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + e.message };
  }
};
