const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const configured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_APP_PASSWORD);
const wrapBase64 = value => value.match(/.{1,76}/g)?.join('\r\n') || '';
const encodedHeader = value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function createHtmlEmail(text, subject) {
  const blocks = String(text).split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').filter(Boolean);
    const hasHeading = lines.length > 1 && (/^[A-Z][A-Z ]{2,}$/.test(lines[0]) || /^Reservation #\d+$/.test(lines[0]));
    const heading = hasHeading ? `<h2 style="margin:0 0 10px;color:#4b1117;font-size:15px;letter-spacing:.04em;">${escapeHtml(lines.shift())}</h2>` : '';
    const rows = lines.map(line => {
      const match = line.match(/^([^:]{2,45}):\s*(.*)$/);
      return match
        ? `<tr><th align="left" valign="top" style="padding:7px 12px 7px 0;color:#766b61;font-weight:400;white-space:nowrap;">${escapeHtml(match[1])}</th><td style="padding:7px 0;color:#342c27;">${escapeHtml(match[2])}</td></tr>`
        : `<tr><td colspan="2" style="padding:5px 0;color:#342c27;line-height:1.5;">${escapeHtml(line)}</td></tr>`;
    }).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">${heading ? `<tr><td colspan="2">${heading}</td></tr>` : ''}${rows}</table>`;
  }).join('');
  return `<!doctype html><html><body style="margin:0;padding:28px 12px;background:#f5f1ed;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:#fff;border:1px solid #e9e1dc;border-radius:12px;overflow:hidden;"><tr><td align="center" style="padding:26px 24px 18px;border-bottom:3px solid #f7d8a6;"><img src="cid:mamanpaz-logo" width="88" alt="Mamanpaz Maastricht" style="display:block;width:88px;height:auto;border:0;margin:0 auto 12px;"><div style="color:#766b61;font-size:11px;letter-spacing:.16em;text-transform:uppercase;">Mamanpaz Maastricht</div></td></tr><tr><td style="padding:26px 30px 8px;"><h1 style="margin:0 0 20px;color:#2b060a;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(subject)}</h1><div style="font-size:15px;line-height:1.6;">${blocks}</div></td></tr><tr><td style="padding:14px 30px 20px;border-top:1px solid #eee8e3;color:#766b61;font-size:12px;line-height:1.6;">Automated message from Mamanpaz Maastricht.</td></tr></table></td></tr></table></body></html>`;
}

function createCalendarInvite(reservation, method = 'REQUEST') {
  const date = reservation.reservation_date.replaceAll('-', '');
  const time = reservation.reservation_time.replace(':', '') + '00';
  const uid = `reservation-${reservation.id}@mamanpazmaastricht.nl`;
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mamanpaz Maastricht//Reservations//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:DAYLIGHT', 'DTSTART:19810329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'DTSTART:19961027T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Amsterdam:${date}T${time}`, `DURATION:PT2H`, 'SUMMARY:Reservation at Mamanpaz Maastricht',
    `ORGANIZER:MAILTO:${process.env.RESTAURANT_EMAIL || 'mamanpazmaastricht@gmail.com'}`, `ATTENDEE;RSVP=FALSE:MAILTO:${reservation.email}`,
    'LOCATION:Clavecymbelstraat 8\\, 6217 CT Maastricht\\, Netherlands',
    `DESCRIPTION:${escape(`Reservation #${reservation.id} for ${reservation.guests} guests at Mamanpaz Maastricht.`)}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
}

async function sendSmtp({ to, subject, text, calendar }) {
  if (!configured()) throw new Error('Email is not configured. Set SMTP_USER and SMTP_APP_PASSWORD.');
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const from = process.env.MAIL_FROM || user;
  const socket = tls.connect({ host, port, servername: host, timeout: 20000 });
  let buffer = '';
  let responseLines = [];
  let waiter;
  let ended = false;
  const replies = [];
  const readReply = () => replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\r\n'); buffer = lines.pop();
    for (const line of lines) {
      responseLines.push(line);
      if (/^\d{3} /.test(line)) {
        const result = responseLines.join('\n'); responseLines = [];
        if (waiter) { const current = waiter; waiter = null; current.resolve(result); }
        else replies.push(result);
      }
    }
  });
  socket.on('timeout', () => { if (waiter) waiter.reject(new Error('SMTP connection timed out.')); socket.destroy(); });
  socket.on('error', error => { if (waiter) waiter.reject(error); });
  socket.on('close', () => { ended = true; if (waiter) waiter.reject(new Error('SMTP connection closed unexpectedly.')); });
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeListener('secureConnect', onSecureConnect);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('close', onClose);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onSecureConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = error => fail(error);
    const onTimeout = () => fail(new Error('SMTP connection timed out during TLS setup.'));
    const onClose = () => fail(new Error('SMTP connection closed before TLS setup completed.'));
    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('close', onClose);
  });
  const expect = async (command, codes, operation) => {
    if (ended) throw new Error('SMTP connection closed.');
    const reply = readReply();
    if (command !== null) socket.write(`${command}\r\n`);
    const result = await reply;
    if (!codes.includes(Number(result.slice(0, 3)))) {
      const explanation = result.split('\n').map(line => line.replace(/^\d{3}[- ]?/, '').trim()).filter(Boolean).join(' ').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
      throw new Error(`SMTP rejected ${operation} (${result.slice(0, 3)}${explanation ? `: ${explanation}` : ''}).`);
    }
    return result;
  };
  try {
    await expect(null, [220], 'connection greeting');
    await expect(`EHLO ${process.env.SMTP_EHLO || 'mamanpazmaastricht.nl'}`, [250], 'EHLO');
    await expect('AUTH LOGIN', [334], 'authentication start');
    await expect(Buffer.from(user).toString('base64'), [334], 'authentication username');
    await expect(Buffer.from(process.env.SMTP_APP_PASSWORD.replace(/\s/g, '')).toString('base64'), [235], 'authentication password');
    await expect(`MAIL FROM:<${from}>`, [250], 'sender address');
    await expect(`RCPT TO:<${to}>`, [250, 251], 'recipient address');
    await expect('DATA', [354], 'message data');
    const boundary = `mamanpaz-${crypto.randomBytes(12).toString('hex')}`;
    const relatedBoundary = `${boundary}-related`;
    const alternativeBoundary = `${boundary}-alternative`;
    const logo = fs.readFileSync(path.join(__dirname, 'icons', 'logomamanpaz.PNG'));
    const relatedContent = [
      `--${relatedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      `--${alternativeBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(text).toString('base64')),
      `--${alternativeBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(createHtmlEmail(text, subject)).toString('base64')),
      `--${alternativeBoundary}--`,
      `--${relatedBoundary}`,
      'Content-Type: image/png; name="mamanpaz-logo.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <mamanpaz-logo>',
      'Content-Disposition: inline; filename="mamanpaz-logo.png"',
      '',
      wrapBase64(logo.toString('base64')),
      `--${relatedBoundary}--`
    ].join('\r\n');
    const messageHeaders = [
      `From: ${encodedHeader('Mamanpaz Maastricht')} <${from}>`, `To: <${to}>`, `Subject: ${encodedHeader(subject)}`,
      'MIME-Version: 1.0',
      calendar ? `Content-Type: multipart/mixed; boundary="${boundary}"` : `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
      ''
    ];
    const messageContent = calendar
      ? `--${boundary}\r\nContent-Type: multipart/related; boundary="${relatedBoundary}"\r\n\r\n${relatedContent}\r\n--${boundary}\r\nContent-Type: text/calendar; charset=UTF-8; method=${calendar.includes('METHOD:CANCEL') ? 'CANCEL' : 'REQUEST'}; name="reservation.ics"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="reservation.ics"\r\n\r\n${wrapBase64(Buffer.from(calendar).toString('base64'))}\r\n--${boundary}--`
      : relatedContent;
    const body = [
      ...messageHeaders, messageContent, ''
    ].join('\r\n').replace(/\n\./g, '\n..');
    const accepted = new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    socket.write(`${body}\r\n.\r\n`);
    const result = await accepted;
    if (!result.startsWith('250 ')) throw new Error(`SMTP rejected message data (${result.slice(0, 3)}).`);
    await expect('QUIT', [221], 'connection close');
  } finally { socket.end(); }
}

module.exports = { configured, sendSmtp, createCalendarInvite };
