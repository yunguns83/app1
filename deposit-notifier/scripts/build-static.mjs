// public/ 의 화면 파일을 Worker 코드 안에 넣는 파일(src/static.gen.js)로 만듭니다.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = new URL('../public/', import.meta.url).pathname;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const type = types[extname(name)];
    if (!type) continue;
    files['/' + relative(root, p)] = { type, b64: readFileSync(p).toString('base64') };
  }
})(root);
writeFileSync(new URL('../src/static.gen.js', import.meta.url),
  '// 자동 생성 파일: npm run build (public/ 수정 후 다시 실행)\nexport default ' + JSON.stringify(files) + ';\n');
console.log('static files:', Object.keys(files).length);
