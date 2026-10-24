/**
 * Regression check for the inbox email parser: npm run parser:check
 *
 * Excluded from the build by the tsconfig check-file pattern, so it never ships. It
 * exists because a silently broken IMAP fetch used to file RFQs whose body was raw
 * protocol text ("* 183 FETCH (BODY[] {0") with the subject lost. Each case builds a
 * byte-accurate server response the way SimpleImapClient sees one: the payload is a
 * latin1 string (1 char === 1 byte) with the literal length declared in bytes.
 */
import {
	extractMimePayload,
	stripImapFraming,
	extractMimeWithAttachments,
	extractCleanEmailBody,
} from './inboxService';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
	if (cond) {
		console.log(`  PASS  ${name}`);
	} else {
		failures++;
		console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
	}
}

/** Emulate the client buffer: MIME bytes read as latin1, length declared in bytes. */
function gmailResponse(seq: number, mime: string, item = 'BODY[]', prefix = '') {
	const latin1 = Buffer.from(mime, 'utf8').toString('latin1');
	const tag = `A${seq % 20 + 2}`;
	return `* ${seq} FETCH (${prefix}${item} {${Buffer.byteLength(mime, 'utf8')}}\r\n${latin1}\r\n)\r\n${tag} OK FETCH completed.\r\n`;
}

const MULTIPART = [
	'Date: Mon, 20 Oct 2026 10:00:00 +0530',
	'From: "Customer" <buyer@example.com>',
	'To: rfq@encon.co.in',
	'Subject: Enquiry for Recuperator',
	'Message-ID: <cae7f1@mail.gmail.com>',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="----=_Part_123"',
	'',
	'------=_Part_123',
	'Content-Type: text/plain; charset=UTF-8',
	'Content-Transfer-Encoding: quoted-printable',
	'',
	'Please send quote for 500kcal recuperator =E2=80=93 thanks.',
	'------=_Part_123',
	'Content-Type: application/pdf; name="spec.pdf"',
	'Content-Transfer-Encoding: base64',
	'Content-Disposition: attachment; filename="spec.pdf"',
	'',
	'JVBERi0xLjQKJcOkw7zDtsOfCg==',
	'------=_Part_123--',
].join('\r\n');

console.log('\n1) Gmail reply names the item BODY[] (command asked for BODY.PEEK[])');
{
	const raw = gmailResponse(183, MULTIPART);
	const { mime, complete, declaredBytes } = extractMimePayload(raw);
	check('literal detected and complete', complete, `declared=${declaredBytes}`);
	check('framing removed from head', mime.startsWith('Date:'), mime.slice(0, 40));
	check('completion line removed', !/OK FETCH completed/.test(mime));
	const parsed = extractMimeWithAttachments(mime);
	check('body text extracted', /500kcal recuperator/.test(parsed.body), parsed.body.slice(0, 80));
	check('no protocol junk in body', !/FETCH|\{1?\d{2,}\}/.test(parsed.body));
	check('attachment found', parsed.attachments.length === 1, `n=${parsed.attachments.length}`);
	check('attachment filename', parsed.attachments[0]?.filename === 'spec.pdf');
	check('attachment decoded (%PDF)', parsed.attachments[0]?.data?.slice(0, 4).toString('latin1') === '%PDF');
}

console.log('\n2) Server lists FLAGS(...) before the body literal');
{
	const raw = gmailResponse(5, MULTIPART, 'BODY[]', 'FLAGS (\\Seen \\Important) ');
	const { mime, complete } = extractMimePayload(raw);
	check('complete', complete);
	check('flags line dropped', mime.startsWith('Date:'), mime.slice(0, 60));
}

console.log('\n3) Truncated download (the screenshot case) is rejected, not stored');
{
	const raw = gmailResponse(183, MULTIPART);
	const cut = raw.substring(0, raw.length - 400);
	const { complete, declaredBytes, mime } = extractMimePayload(cut);
	check('flagged incomplete', !complete, `declared=${declaredBytes} got=${mime.length}`);
	const junkOnly = '* 183 FETCH (BODY[] {0';
	const { complete: junkComplete, mime: junkMime } = extractMimePayload(junkOnly);
	check('zero-length literal rejected', !junkComplete || !junkMime.trim());
}

console.log('\n4) Header-only fetch (oversized message path)');
{
	const headers = 'Date: Mon, 20 Oct 2026 10:00:00 +0530\r\nFrom: buyer@example.com\r\nSubject: Enquiry for Recuperator\r\nMessage-ID: <h1@mail.gmail.com>';
	const raw = gmailResponse(9, headers, 'BODY[HEADER]');
	const { mime } = extractMimePayload(raw);
	check('header literal extracted', mime.startsWith('Date:'), mime.slice(0, 40));
	check('subject intact', /Subject: Enquiry for Recuperator/.test(mime));
}

console.log('\n5) LITERAL+ marker {N+} (some servers)');
{
	const latin1 = Buffer.from(MULTIPART, 'utf8').toString('latin1');
	const raw = `* 12 FETCH (BODY[] {${Buffer.byteLength(MULTIPART, 'utf8')}+}\r\n${latin1}\r\n)\r\nA7 OK FETCH completed.\r\n`;
	const { mime, complete } = extractMimePayload(raw);
	check('complete with {N+}', complete);
	check('payload correct', mime.startsWith('Date:'));
}

console.log('\n6) Repair path for rows already stored with framing glued on');
{
	const stored = `* 183 FETCH (BODY[] {18345}\r\n${MULTIPART}\r\n)\r\nA20 OK FETCH completed.`;
	const cleaned = extractCleanEmailBody(stored);
	check('no FETCH text left in stored body', !/FETCH/.test(cleaned), cleaned.slice(0, 60));
	check('body recovered', /recuperator/.test(cleaned), cleaned.slice(0, 60));
	check('screenshot junk yields empty, not garbage', !/FETCH/.test(extractCleanEmailBody('* 183 FETCH (BODY[] {0')));
	check('stripImapFraming idempotent on clean mime', stripImapFraming(MULTIPART) === MULTIPART.trim());
}

console.log('\n7) Non-ASCII 8bit body survives the latin1 buffer');
{
	const utf8Mime = [
		'Date: Tue, 21 Oct 2026 09:00:00 +0530',
		'From: buyer@example.com',
		'Subject: Burner enquiry',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: 8bit',
		'',
		'कृपया उद्धरण भेजें — please quote for 2 burners.',
	].join('\r\n');
	const raw = gmailResponse(77, utf8Mime);
	const { mime, complete } = extractMimePayload(raw);
	check('complete', complete);
	const parsed = extractMimeWithAttachments(mime);
	check('Devanagari decoded', parsed.body.includes('कृपया'), JSON.stringify(parsed.body.slice(0, 40)));
	check('em dash decoded', parsed.body.includes('—'), JSON.stringify(parsed.body.slice(0, 60)));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
