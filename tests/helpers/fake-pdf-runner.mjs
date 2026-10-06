// 견적 PDF 도우미 테스트용 가짜 실행기(quote-tool Design §11.6, tests/quote-pdf-helper.test.mjs).
// 도우미가 quote-xlsx-to-pdf.ps1 과 같은 인자(-In -Out -Sheet -PidFile)로 띄운다(XD_NODE_QUOTE_PDF_RUNNER). Excel 은 쓰지 않는다.
// 동작은 시트명으로 고른다: "ok"(바로 PDF), "sleep-<ms>"(기다린 뒤 PDF), "exit-<n>"(종료 코드 n), "hang"(끝나지 않음), "pages-<n>"(n쪽).
// FAKE_PDF_LOG_DIR 이 있으면 실행마다 run-<pid>.json 에 pid·cwd·인자를 남긴다(시간 초과 뒤 프로세스·임시 폴더 정리 확인용).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const sheet = option('-Sheet');
const out = option('-Out');
if (process.env.FAKE_PDF_LOG_DIR) {
  writeFileSync(join(process.env.FAKE_PDF_LOG_DIR, `run-${process.pid}.json`), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, in: option('-In'), out, sheet }));
}
// pid 파일에는 자기 pid 를 쓴다(이름이 EXCEL 이 아니므로 도우미의 Excel 정리 대상이 아니어야 한다).
writeFileSync(option('-PidFile'), String(process.pid));

const writePdf = (pages = 1) => {
  const body = Array.from({ length: pages }, (_, index) => `${index + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('');
  writeFileSync(out, `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${body}%%EOF\n`);
};

let match;
if (sheet === 'hang') setInterval(() => {}, 1000);
else if ((match = /^exit-(\d+)$/.exec(sheet))) process.exit(Number(match[1]));
else if ((match = /^sleep-(\d+)$/.exec(sheet))) setTimeout(() => { writePdf(); process.exit(0); }, Number(match[1]));
else if ((match = /^pages-(\d+)$/.exec(sheet))) { writePdf(Number(match[1])); process.exit(0); }
else { writePdf(); process.exit(0); }
